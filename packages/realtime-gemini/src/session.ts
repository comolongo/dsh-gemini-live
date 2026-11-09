/**
 * The Gemini Live session implementing the RealtimeSession contract.
 *
 * Two mappings are worth reading before changing anything here:
 *
 * **Answers travel as a `toolResponse`, not as spoken words.** A delegation arrives as a `toolCall`, and the
 * model is blocked until the matching `FunctionResponse` arrives (the declaration omits `behavior`, which
 * means `BLOCKING`). So `appendCommentary(content, delegationId)` writes that response — carrying the call's
 * own function name, because a response is matched to its call by `id` *and* `name`.
 *
 * **Text is a transcription, not a model part.** Native-audio models only emit audio; the setup asks for both
 * input and output transcription, and the text arrives on `serverContent.inputTranscription` /
 * `outputTranscription`. Output transcription is chunked, so the newest chunk is held until the next one
 * arrives or the turn completes — that way the last fragment of a turn is the one marked `final`.
 *
 * @module dsh-realtime-gemini/session
 */

import { REALTIME_ERROR_CODES, RealtimeError } from 'dsh-realtime'
import type {
  RealtimeAudioFormat,
  RealtimeDelegation,
  RealtimeSession,
  RealtimeSessionHandlers,
  RealtimeSessionStarted,
} from 'dsh-realtime'
import { PcmResampler24to16 } from './resample.ts'
import type { GeminiTransport } from './transport.ts'
import type { GeminiServerMessage } from './wire.ts'
import { DEFAULT_CODING_TOOL, buildClientContentMessage, buildToolResponseMessage } from './wire.ts'

export interface GeminiSessionOptions {
  readonly id: string
  readonly provider: string
  readonly model: string
  readonly voice?: string
  readonly transport: GeminiTransport
  readonly handlers: RealtimeSessionHandlers
}

function audioFormat(sampleRate: number): RealtimeAudioFormat {
  return { sampleRate, channels: 1, encoding: 'pcm16' }
}

export class GeminiLiveSession implements RealtimeSession {
  readonly id: string
  readonly started: RealtimeSessionStarted

  private readonly transport: GeminiTransport
  private readonly handlers: RealtimeSessionHandlers
  private readonly resampler = new PcmResampler24to16()
  private readonly startTime = Date.now()

  private muted = false
  private closed = false

  /**
   * Function names by call id, learned from each `toolCall`.
   *
   * A `FunctionResponse` must carry the function's name, and this session is the only place that saw it. The
   * map is also why an answer for an id nobody called can still be written: it falls back to the one function
   * this adapter declares.
   */
  private readonly callNames = new Map<string, string>()

  /**
   * Tool calls the model withdrew with `toolCallCancellation`.
   *
   * Barge-in on this provider is the model's own VAD: it stops speaking and cancels the function calls it had
   * asked for. An answer for one of those is no longer a result the model is waiting on, and sending a
   * `toolResponse` for an id it has forgotten is a session error dressed as an append. The delegation still
   * settles upstream — its answer simply goes nowhere, which is what "cancelled" means.
   */
  private readonly cancelledCalls = new Set<string>()

  /** The newest output-transcription chunk, held so the turn's last chunk is the one marked `final`. */
  private heldOutput = ''

  constructor(options: GeminiSessionOptions) {
    this.id = options.id
    this.transport = options.transport
    this.handlers = options.handlers

    this.started = {
      provider: options.provider,
      model: options.model,
      voice: options.voice ?? 'Puck',
      inputAudio: audioFormat(16_000),
      outputAudio: audioFormat(24_000),
    }
  }

  /**
   * Resamples incoming 24 kHz microphone audio to 16 kHz and streams to Gemini.
   */
  sendAudio(pcm16: Uint8Array): void {
    if (this.closed || this.muted) return
    const pcm16_16k = this.resampler.process(pcm16)
    if (pcm16_16k.length > 0) {
      this.transport.sendAudio(pcm16_16k)
    }
  }

  muteInput(): void {
    this.muted = true
  }

  unmuteInput(): void {
    this.muted = false
  }

  /**
   * Return a delegated result for the model to speak aloud.
   * If delegationId is provided, delivers an in-band tool response to Gemini Live.
   */
  async appendCommentary(content: string, delegationId?: string): Promise<void> {
    if (this.closed) return
    if (delegationId !== undefined) {
      // `has`, not `delete`: a withdrawn call stays withdrawn, and the same id may be answered on
      // more than one channel (an answer and a narration line). Deleting on the first use let the
      // second one write a toolResponse for a call the provider had already forgotten.
      if (this.cancelledCalls.has(delegationId)) return
      const name = this.callNames.get(delegationId) ?? DEFAULT_CODING_TOOL.name
      this.transport.send(buildToolResponseMessage(delegationId, name, content))
      return
    }
    // Session-wide injection: send as user content turn
    this.transport.send(buildClientContentMessage(content))
  }

  /**
   * Injects a line into the ongoing conversation.
   */
  async injectLine(content: string, delegationId?: string): Promise<void> {
    if (this.closed) return
    if (delegationId !== undefined && this.cancelledCalls.has(delegationId)) return
    this.transport.send(buildClientContentMessage(content))
  }

  /**
   * Silent thinking is declared unsupported by Gemini Live.
   */
  async appendThinking(_content: string, _delegationId?: string): Promise<void> {
    throw new RealtimeError(
      'Gemini Live cannot append thinking: it declares appendThinking = false',
      REALTIME_ERROR_CODES.CAPABILITY_UNSUPPORTED,
    )
  }

  /**
   * Mid-session steering context appended via client content.
   */
  async appendInstructions(content: string, _delegationId?: string): Promise<void> {
    if (this.closed) return
    this.transport.send(buildClientContentMessage(`[System Instruction Update]: ${content}`))
  }

  /**
   * Feed an incoming parsed server message to this session.
   */
  receive(msg: GeminiServerMessage): void {
    if (this.closed) return

    // 1. Check for provider errors
    if (msg.error !== undefined) {
      const errorMsg = msg.error.message ?? 'Gemini Live error'
      this.handlers.onError?.(new RealtimeError(errorMsg, REALTIME_ERROR_CODES.PROVIDER_ERROR))
      return
    }

    // 2. Text parts, for any model that emits text alongside audio. Native-audio models do not; their text
    //    arrives at step 3 instead.
    const parts = msg.serverContent?.modelTurn?.parts
    if (parts !== undefined) {
      for (const part of parts) {
        if (typeof part.text === 'string' && part.text.length > 0) {
          this.handlers.onTranscript?.({
            kind: 'output',
            text: part.text,
            final: msg.serverContent?.turnComplete === true,
          })
        }
      }
    }

    // 3. Transcription. The user's words are already utterance-level (the frequent-update stream is a separate
    //    field this adapter ignores), so they are reported as they arrive. The model's words are chunked, so
    //    they go through the hold-and-release path below.
    const input = msg.serverContent?.inputTranscription?.text
    if (input !== undefined && input.length > 0) {
      this.handlers.onTranscript?.({ kind: 'input', text: input, final: true })
    }
    const output = msg.serverContent?.outputTranscription?.text
    if (output !== undefined && output.length > 0) this.emitOutput(output, false)
    if (msg.serverContent?.turnComplete === true) this.emitOutput(undefined, true)

    // 4. Remember tool calls: the name is needed to answer them, and a withdrawn call must not be answered.
    const functionCalls = msg.toolCall?.functionCalls
    if (functionCalls !== undefined && functionCalls.length > 0) {
      for (const call of functionCalls) {
        this.callNames.set(call.id, call.name)
        const delegation: RealtimeDelegation = {
          id: call.id,
          target: 'client',
          offsetMs: Date.now() - this.startTime,
          payload: call.args ?? {},
        }
        this.handlers.onDelegation?.(delegation)
      }
    }
    const cancelled = msg.toolCallCancellation?.ids
    if (cancelled !== undefined) {
      for (const id of cancelled) this.cancelledCalls.add(id)
    }

    // 5. Handle usage reports if present
    if (msg.usageMetadata?.totalTokenCount !== undefined) {
      // Audio-second estimate or rough token-to-seconds proxy
      this.handlers.onUsage?.({
        seconds: Math.round(msg.usageMetadata.totalTokenCount / 50),
      })
    }
  }

  /**
   * Report a transcription fragment, holding the newest chunk until the next chunk or the turn's end.
   *
   * The hold exists because the last chunk of a turn is the one that closes the utterance: releasing every
   * chunk immediately would mark each `final`, and the seam's consumers would see a turn split into one
   * utterance per sentence fragment.
   */
  private emitOutput(text: string | undefined, final: boolean): void {
    if (text !== undefined) {
      if (this.heldOutput.length > 0) {
        this.handlers.onTranscript?.({ kind: 'output', text: this.heldOutput, final: false })
      }
      this.heldOutput = text
    }
    if (!final) return
    const closing = this.heldOutput
    this.heldOutput = ''
    if (closing.length > 0) {
      this.handlers.onTranscript?.({ kind: 'output', text: closing, final: true })
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    // Whatever the model had said but not yet closed is still worth reporting: a transcript that vanishes on
    // close is a caption the person watched disappear.
    this.emitOutput(undefined, true)
    this.resampler.reset()
    await this.transport.close()
  }
}
