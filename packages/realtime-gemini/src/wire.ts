/**
 * Wire protocol types and message builders for the Gemini Multimodal Live API.
 *
 * Grounded in the official BidiGenerateContent WebSocket specification:
 * wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent
 *
 * Read against the published reference on 2026-11-09, which changed three shapes this module used to spell
 * differently — and each one would have failed on a live socket rather than in a test:
 *
 * 1. **Audio is `realtimeInput.audio`**, a single `Blob`. `mediaChunks[]` is documented as deprecated, and
 *    "multiple `mediaChunks` are not supported, all but the first will be ignored". The old shape would have
 *    sent audio the server read as an empty stream: no error, no speech, no transcript.
 * 2. **A `FunctionResponse` carries `name`** as well as `id`, and its `response` is the result object directly
 *    (`{ result }`), not an `output` wrapper. A response without a name cannot be matched to its call.
 * 3. **Text comes from transcription on native-audio models.** They only support the `AUDIO` response
 *    modality, so `modelTurn.parts[].text` is absent; captions arrive as `serverContent.outputTranscription`
 *    (and the user's words as `inputTranscription`) once the setup enables both.
 *
 * @module dsh-realtime-gemini/wire
 */

export interface GeminiFunctionDeclaration {
  readonly name: string
  readonly description?: string
  readonly parameters?: {
    readonly type: string
    readonly properties?: Readonly<Record<string, { readonly type: string; readonly description?: string }>>
    readonly required?: readonly string[]
  }
  /**
   * `BLOCKING` (the default when omitted) makes the model wait for the tool response before speaking again.
   * This adapter relies on that: a delegation is answered by a `toolResponse`, and the model's next turn is
   * the spoken summary. `NON_BLOCKING` would need `scheduling` on the response instead.
   */
  readonly behavior?: 'BLOCKING' | 'NON_BLOCKING'
}

/** Standard coding agent tool declaration passed in the Gemini setup frame. */
export const DEFAULT_CODING_TOOL: GeminiFunctionDeclaration = Object.freeze({
  name: 'ask_coding_agent',
  description:
    'Ask the DeepSeek Harness coding agent to perform a task in the workspace: write or edit code, inspect files, run tests or terminal commands, check git, manage sessions, or use installed tools such as the browser bridge. The agent has the tools; describe the task fully, including any site, file or command the user named.',
  parameters: {
    type: 'OBJECT',
    properties: {
      task: {
        type: 'STRING',
        description: 'The exact coding or workspace task to execute.',
      },
    },
    required: ['task'],
  },
})

export interface GeminiSetupMessage {
  readonly setup: {
    readonly model: string
    readonly generationConfig?: {
      readonly responseModalities?: readonly ('AUDIO' | 'TEXT')[]
      readonly speechConfig?: {
        readonly voiceConfig?: {
          readonly prebuiltVoiceConfig?: {
            readonly voiceName?: string
          }
        }
      }
    }
    readonly systemInstruction?: {
      readonly parts: readonly { readonly text: string }[]
    }
    readonly tools?: readonly {
      readonly functionDeclarations: readonly GeminiFunctionDeclaration[]
    }[]
    /**
     * Enables transcripts of the model's own speech. An empty object is the documented "on"; there is no
     * boolean. Without it a native-audio model produces no text at all, so captions and the journal would be
     * empty for reasons no error names.
     */
    readonly outputAudioTranscription?: Readonly<Record<string, never>>
    /** Enables transcripts of the user's speech, which is what makes `transcript.input` journalable. */
    readonly inputAudioTranscription?: Readonly<Record<string, never>>
  }
}

export interface GeminiRealtimeInputMessage {
  readonly realtimeInput: {
    /**
     * One audio blob per frame. `mimeType` conveys the sample rate; the API resamples if the rate is not its
     * native 16 kHz, but this adapter resamples client-side so the wire carries the native rate.
     */
    readonly audio: {
      readonly mimeType: 'audio/pcm;rate=16000'
      readonly data: string // base64
    }
  }
}

/**
 * Flush what the server has cached for the audio stream.
 *
 * The reference: "When the audio stream is paused for more than a second (for example, because the user
 * switched off the microphone), an `audioStreamEnd` event should be sent to flush any cached audio." Without
 * it, the utterance before a mute can sit in the server's buffer and never be answered.
 */
export interface GeminiAudioStreamEndMessage {
  readonly realtimeInput: {
    readonly audioStreamEnd: true
  }
}

export interface GeminiClientContentMessage {
  readonly clientContent: {
    readonly turns: readonly {
      readonly role: 'user' | 'model'
      readonly parts: readonly { readonly text: string }[]
    }[]
    readonly turnComplete: boolean
  }
}

export interface GeminiFunctionResponse {
  /** The call this answers. */
  readonly id: string
  /** The declared function's name. Required: a response is matched to its call by id *and* name. */
  readonly name: string
  /** The result object itself — `{ result }` is the shape this adapter uses, not an `output` wrapper. */
  readonly response: { readonly result: string }
}

export interface GeminiToolResponseMessage {
  readonly toolResponse: {
    readonly functionResponses: readonly GeminiFunctionResponse[]
  }
}

export type GeminiClientMessage =
  | GeminiSetupMessage
  | GeminiRealtimeInputMessage
  | GeminiAudioStreamEndMessage
  | GeminiClientContentMessage
  | GeminiToolResponseMessage

export interface GeminiServerPart {
  readonly text?: string
  readonly inlineData?: {
    readonly mimeType: string
    readonly data: string // base64
  }
}

/** One transcription fragment, for either side of the conversation. */
export interface GeminiTranscription {
  readonly text?: string
  readonly languageCode?: string
}

export interface GeminiServerContent {
  readonly modelTurn?: {
    readonly parts?: readonly GeminiServerPart[]
  }
  /** The model's finished speaking its turn. The last output transcription arrives before this. */
  readonly turnComplete?: boolean
  /** The model is done generating, which precedes `turnComplete` when playback timing is involved. */
  readonly generationComplete?: boolean
  /** The user prompted over the model, so anything already spoken can be dropped. */
  readonly interrupted?: boolean
  /** The user's words, as transcribed. Sent independently of the other events, with no ordering guarantee. */
  readonly inputTranscription?: GeminiTranscription
  /** Low-latency partial input transcription, updated while the user is speaking. */
  readonly interimInputTranscription?: GeminiTranscription
  /** The model's words, as transcribed. Chunked; the last chunk of a turn arrives before `turnComplete`. */
  readonly outputTranscription?: GeminiTranscription
  /** Present alongside `turnComplete`; `IDLE` means the server has finished all processing. */
  readonly interactionStatus?: 'INTERACTION_STATUS_UNSPECIFIED' | 'IN_PROGRESS' | 'REQUIRES_ACTION' | 'IDLE'
}

export interface GeminiToolCallItem {
  readonly id: string
  readonly name: string
  readonly args?: Record<string, unknown>
}

export interface GeminiServerMessage {
  readonly setupComplete?: Record<string, unknown>
  readonly serverContent?: GeminiServerContent
  readonly toolCall?: {
    readonly functionCalls?: readonly GeminiToolCallItem[]
  }
  readonly toolCallCancellation?: {
    readonly ids?: readonly string[]
  }
  /** The server will disconnect shortly; audio-only sessions are capped at 15 minutes. */
  readonly goAway?: {
    readonly timeLeft?: string
  }
  readonly usageMetadata?: {
    readonly totalTokenCount?: number
    readonly candidatesTokenCount?: number
    readonly promptTokenCount?: number
    readonly responseTokenCount?: number
    readonly thoughtsTokenCount?: number
  }
  readonly error?: {
    readonly code?: number
    readonly message?: string
    readonly status?: string
  }
}

/** Format model name ensuring the "models/" prefix Google expects. */
export function normalizeModelName(model: string): string {
  const trimmed = model.trim()
  return trimmed.startsWith('models/') ? trimmed : `models/${trimmed}`
}

/** Build the setup message sent immediately upon opening the WebSocket. */
export function buildSetupMessage(options: {
  readonly model: string
  readonly voice?: string
  readonly instructions?: string
  readonly tools?: readonly GeminiFunctionDeclaration[]
}): GeminiSetupMessage {
  return {
    setup: {
      model: normalizeModelName(options.model),
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: options.voice ?? 'Puck',
            },
          },
        },
      },
      ...(options.instructions !== undefined && options.instructions.trim().length > 0
        ? { systemInstruction: { parts: [{ text: options.instructions.trim() }] } }
        : {}),
      tools: [
        {
          functionDeclarations: options.tools ?? [DEFAULT_CODING_TOOL],
        },
      ],
      // Both, always. Captions are the only text a native-audio model emits, and the input transcript is what
      // the agent journals as `transcript.input` — a session without these is silent in a way nothing reports.
      outputAudioTranscription: {},
      inputAudioTranscription: {},
    },
  }
}

/** Build audio input frame (16 kHz PCM16 base64 encoded). */
export function buildAudioInputMessage(pcm16_16k: Uint8Array): GeminiRealtimeInputMessage {
  const base64 = Buffer.from(pcm16_16k.buffer, pcm16_16k.byteOffset, pcm16_16k.byteLength).toString('base64')
  return {
    realtimeInput: {
      audio: {
        mimeType: 'audio/pcm;rate=16000',
        data: base64,
      },
    },
  }
}

/** Build the frame that flushes cached audio when the input stream pauses. */
export function buildAudioStreamEndMessage(): GeminiAudioStreamEndMessage {
  return { realtimeInput: { audioStreamEnd: true } }
}

/** Build tool call response message. The `name` is the one the call carried, not a guess. */
export function buildToolResponseMessage(callId: string, name: string, result: string): GeminiToolResponseMessage {
  return {
    toolResponse: {
      functionResponses: [
        {
          id: callId,
          name,
          response: {
            result,
          },
        },
      ],
    },
  }
}

/** Build client content text injection. */
export function buildClientContentMessage(text: string): GeminiClientContentMessage {
  return {
    clientContent: {
      turns: [
        {
          role: 'user',
          parts: [{ text }],
        },
      ],
      turnComplete: true,
    },
  }
}

/** Safely parse inbound server JSON frame. */
export function parseServerMessage(data: string): GeminiServerMessage {
  return JSON.parse(data) as GeminiServerMessage
}
