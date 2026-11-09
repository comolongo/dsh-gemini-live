/**
 * The Gemini Live adapter: registers the gemini-live route on the realtime seam.
 *
 * @module dsh-realtime-gemini/adapter
 */

import { REALTIME_ERROR_CODES, RealtimeAdapter, RealtimeError } from 'dsh-realtime'
import type {
  RealtimeModelInfo,
  RealtimeProviderInfo,
  RealtimeSession,
  RealtimeSessionOptions,
} from 'dsh-realtime'
import { GEMINI_CAPABILITIES } from './capabilities.ts'
import { GeminiLiveSession } from './session.ts'
import type { SocketLike } from './transport.ts'
import { openGeminiTransport } from './transport.ts'
import type { GeminiServerMessage } from './wire.ts'
import { buildSetupMessage } from './wire.ts'

export const GEMINI_LIVE_ENDPOINT =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent'

/** The default route model. Read from the published model list on 2026-11-09; the 2.0-live experiments this
 * adapter was first written against are gone, and a retired model fails on the first session with a provider
 * error that names a model id nobody recognises. */
export const DEFAULT_GEMINI_MODEL = 'models/gemini-3.8-live'
export const DEFAULT_GEMINI_VOICE = 'Puck'

export type SocketFactory = (url: string) => SocketLike

export interface GeminiAdapterConfig {
  readonly apiKey?: string
  readonly endpoint?: string
  readonly model?: string
  readonly voice?: string
  readonly instructions?: string
  readonly establishTimeoutMs?: number
}

/**
 * The Live models this adapter can drive.
 *
 * `gemini-3.8-live-extended-thinking` is deliberately absent: it requires asynchronous function calling
 * (`behavior: NON_BLOCKING` plus `scheduling` on each response), and this adapter answers with a blocking
 * `toolResponse`. Advertising it would promise a mode the delegation path does not implement.
 */
const ADVERTISED_MODELS: readonly RealtimeModelInfo[] = [
  {
    id: 'gemini-3.8-live',
    name: 'Gemini 3.8 Live',
    inputModalities: ['audio', 'text'],
    outputModalities: ['audio', 'text'],
  },
  {
    id: 'gemini-3.1-flash-live-preview',
    name: 'Gemini 3.1 Flash Live (Legacy Preview)',
    inputModalities: ['audio', 'text'],
    outputModalities: ['audio', 'text'],
  },
]

export function hasApiKey(config: GeminiAdapterConfig): boolean {
  return (config.apiKey ?? '').trim().length > 0
}

export class GeminiLiveAdapter extends RealtimeAdapter {
  private readonly config: GeminiAdapterConfig
  private readonly openSocket: SocketFactory

  constructor(config: GeminiAdapterConfig, openSocket: SocketFactory) {
    super()
    this.config = config
    this.openSocket = openSocket
  }

  override providerInfo(provider: string): RealtimeProviderInfo {
    return {
      id: provider,
      name: 'Gemini Live',
      description: 'Gemini Live full-duplex voice with in-band function calling',
      capabilities: GEMINI_CAPABILITIES,
      configured: hasApiKey(this.config),
    }
  }

  override listModels(): Promise<readonly RealtimeModelInfo[]> {
    return Promise.resolve(ADVERTISED_MODELS)
  }

  override async session(options: RealtimeSessionOptions): Promise<RealtimeSession> {
    const key = this.config.apiKey?.trim()
    if (key === undefined || key.length === 0) {
      throw new RealtimeError(
        'no Gemini API key configured: set GEMINI_API_KEY or apiKey in plugin config',
        REALTIME_ERROR_CODES.MISSING_CREDENTIAL,
      )
    }

    if (options.signal?.aborted === true) {
      throw new RealtimeError('the session was abandoned before it opened', REALTIME_ERROR_CODES.NETWORK)
    }

    const endpoint = this.config.endpoint ?? GEMINI_LIVE_ENDPOINT
    const url = `${endpoint}?key=${encodeURIComponent(key)}`
    const handlers = options.handlers ?? {}

    const socket = this.openSocket(url)
    const timeoutMs = this.config.establishTimeoutMs ?? 20_000

    let settleEstablishment: ((err?: Error) => void) | undefined
    const established = new Promise<void>((resolve, reject) => {
      settleEstablishment = (err?: Error) => {
        if (err !== undefined) reject(err)
        else resolve()
      }
    })

    const once = (err?: Error): void => {
      const fn = settleEstablishment
      settleEstablishment = undefined
      fn?.(err)
    }

    let session: GeminiLiveSession | undefined

    const transport = openGeminiTransport(socket, {
      onMessage: (msg: GeminiServerMessage) => {
        // Handshake completion check
        if (msg.setupComplete !== undefined) {
          once()
        }
        if (msg.error !== undefined) {
          const errMsg = msg.error.message ?? 'Gemini rejected the session setup'
          once(new RealtimeError(errMsg, REALTIME_ERROR_CODES.PROVIDER_ERROR))
        }
        session?.receive(msg)
      },
      onAudio: (pcm16) => {
        // Counted before delivery, so usage measures what the session actually carried.
        session?.noteOutputAudio(pcm16.byteLength)
        handlers.onAudio?.(pcm16)
      },
      onClose: (reason) => {
        once(
          new RealtimeError(
            `the provider closed before establishment${reason ? `: ${reason}` : ''}`,
            REALTIME_ERROR_CODES.NETWORK,
          ),
        )
        handlers.onClosed?.(reason)
      },
      onError: (err) => {
        const coded =
          err instanceof RealtimeError ? err : new RealtimeError(err.message, REALTIME_ERROR_CODES.NETWORK)
        once(coded)
        handlers.onError?.(coded)
      },
    })

    const model = options.model || this.config.model || DEFAULT_GEMINI_MODEL
    const voice = options.voice || this.config.voice || DEFAULT_GEMINI_VOICE
    const instructions = options.instructions || this.config.instructions

    // Build and send initial setup message
    transport.send(
      buildSetupMessage({
        model,
        voice,
        ...(instructions !== undefined ? { instructions } : {}),
      }),
    )

    const sessionId = `gemini-live-${Date.now()}`
    session = new GeminiLiveSession({
      id: sessionId,
      provider: options.provider,
      model,
      voice,
      transport,
      handlers,
    })

    // Establish budget
    let timeoutHandle!: ReturnType<typeof setTimeout>
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(
          new RealtimeError(
            `the provider did not complete setup within ${timeoutMs} ms`,
            REALTIME_ERROR_CODES.PROVIDER_TIMEOUT,
          ),
        )
      }, timeoutMs)
    })

    try {
      await Promise.race([established, timeoutPromise])
    } finally {
      clearTimeout(timeoutHandle)
    }

    handlers.onReady?.(session.started)
    return session
  }
}
