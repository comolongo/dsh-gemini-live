/**
 * The Gemini Live session implementing the RealtimeSession contract.
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
import { buildClientContentMessage, buildToolResponseMessage } from './wire.ts'

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
   * Tool calls the model withdrew with `toolCallCancellation`.
   *
   * Barge-in on this provider is the model's own VAD: it stops speaking and cancels the function calls
   * it had asked for. An answer for one of those is no longer a result the model is waiting on, and
   * sending a `toolResponse` for an id it has forgotten is a session error dressed as an append. The
   * delegation still settles upstream — its answer simply goes nowhere, which is what "cancelled" means.
   */
  private readonly cancelledCalls = new Set<string>()

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
      this.transport.send(buildToolResponseMessage(delegationId, content))
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

    // 2. Check for transcripts in modelTurn
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

    // 3. Remember tool calls the model withdrew. The model stops its own speech on barge-in; a function
    // call it had asked for is cancelled with it, and an answer for one must not be written back.
    const cancelled = msg.toolCallCancellation?.ids
    if (cancelled !== undefined) {
      for (const id of cancelled) this.cancelledCalls.add(id)
    }

    // 4. Handle tool calls
    const functionCalls = msg.toolCall?.functionCalls
    if (functionCalls !== undefined && functionCalls.length > 0) {
      for (const call of functionCalls) {
        const delegation: RealtimeDelegation = {
          id: call.id,
          target: 'client',
          offsetMs: Date.now() - this.startTime,
          payload: call.args ?? {},
        }
        this.handlers.onDelegation?.(delegation)
      }
    }

    // 5. Handle usage reports if present
    if (msg.usageMetadata?.totalTokenCount !== undefined) {
      // Audio-second estimate or rough token-to-seconds proxy
      this.handlers.onUsage?.({
        seconds: Math.round(msg.usageMetadata.totalTokenCount / 50),
      })
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.resampler.reset()
    await this.transport.close()
  }
}
