/**
 * Wire protocol types and message builders for the Gemini Multimodal Live API.
 *
 * Grounded in the official BidiGenerateContent WebSocket specification:
 * wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent
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
}

/** Standard coding agent tool declaration passed in the Gemini setup frame. */
export const DEFAULT_CODING_TOOL: GeminiFunctionDeclaration = Object.freeze({
  name: 'ask_coding_agent',
  description:
    'Ask the DeepSeek Harness coding agent to perform a task in the workspace (write/edit code, inspect files, run tests, check git status, or execute terminal commands).',
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
  }
}

export interface GeminiRealtimeInputMessage {
  readonly realtimeInput: {
    readonly mediaChunks: readonly {
      readonly mimeType: 'audio/pcm;rate=16000'
      readonly data: string // base64
    }[]
  }
}

export interface GeminiClientContentMessage {
  readonly clientContent: {
    readonly turns: readonly {
      readonly role: 'user'
      readonly parts: readonly { readonly text: string }[]
    }[]
    readonly turnComplete: boolean
  }
}

export interface GeminiToolResponseMessage {
  readonly toolResponse: {
    readonly functionResponses: readonly {
      readonly id: string
      readonly response: {
        readonly output: {
          readonly result: string
        }
      }
    }[]
  }
}

export type GeminiClientMessage =
  | GeminiSetupMessage
  | GeminiRealtimeInputMessage
  | GeminiClientContentMessage
  | GeminiToolResponseMessage

export interface GeminiServerPart {
  readonly text?: string
  readonly inlineData?: {
    readonly mimeType: string
    readonly data: string // base64
  }
}

export interface GeminiServerContent {
  readonly modelTurn?: {
    readonly parts?: readonly GeminiServerPart[]
  }
  readonly turnComplete?: boolean
  readonly interrupted?: boolean
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
  readonly usageMetadata?: {
    readonly totalTokenCount?: number
    readonly candidatesTokenCount?: number
    readonly promptTokenCount?: number
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
    },
  }
}

/** Build audio input frame (16 kHz PCM16 base64 encoded). */
export function buildAudioInputMessage(pcm16_16k: Uint8Array): GeminiRealtimeInputMessage {
  const base64 = Buffer.from(pcm16_16k.buffer, pcm16_16k.byteOffset, pcm16_16k.byteLength).toString('base64')
  return {
    realtimeInput: {
      mediaChunks: [
        {
          mimeType: 'audio/pcm;rate=16000',
          data: base64,
        },
      ],
    },
  }
}

/** Build tool call response message. */
export function buildToolResponseMessage(callId: string, result: string): GeminiToolResponseMessage {
  return {
    toolResponse: {
      functionResponses: [
        {
          id: callId,
          response: {
            output: {
              result,
            },
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
