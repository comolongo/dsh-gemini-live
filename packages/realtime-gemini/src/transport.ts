/**
 * WebSocket transport for the Gemini Multimodal Live API.
 *
 * Encapsulates the socket connection, frame serialization, audio base64 decoding,
 * and buffering prior to socket open.
 *
 * @module dsh-realtime-gemini/transport
 */

import type { GeminiClientMessage, GeminiServerMessage } from './wire.ts'
import { buildAudioInputMessage, parseServerMessage } from './wire.ts'

/** The socket surface needed — structurally matches `ws.WebSocket` or browser `WebSocket`. */
export interface SocketLike {
  send(data: string | Uint8Array): void
  close(): void
  on(event: 'open' | 'message' | 'close' | 'error', listener: (...args: never[]) => void): void
}

export interface GeminiTransportHandlers {
  /** Inbound parsed server message. */
  readonly onMessage: (msg: GeminiServerMessage) => void
  /** Inbound decoded PCM16 24 kHz output audio. */
  readonly onAudio?: (pcm16: Uint8Array) => void
  /** The socket closed. */
  readonly onClose: (reason?: string) => void
  /** Transport or parse error. */
  readonly onError: (error: Error) => void
}

export interface GeminiTransport {
  /** Send a structured JSON client message. */
  send(msg: GeminiClientMessage): void
  /** Send a resampled 16 kHz PCM16 chunk as realtimeInput. */
  sendAudio(pcm16_16k: Uint8Array): void
  /** Close the transport. */
  close(): Promise<void>
}

/** Converts WebSocket message payload (Buffer, ArrayBuffer, or string) to string. */
function toText(data: unknown): string {
  if (typeof data === 'string') return data
  if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return String(data)
}

/**
 * Bind a socket to Gemini transport handlers.
 * Buffers early sends until socket `open` fires.
 */
export function openGeminiTransport(socket: SocketLike, handlers: GeminiTransportHandlers): GeminiTransport {
  let open = false
  let closed = false
  const buffered: string[] = []

  const write = (json: string): void => {
    if (closed) return
    if (!open) {
      buffered.push(json)
      return
    }
    socket.send(json)
  }

  socket.on('open', () => {
    open = true
    for (const frame of buffered.splice(0, buffered.length)) {
      socket.send(frame)
    }
  })

  socket.on('message', (raw: unknown) => {
    try {
      const text = toText(raw)
      const msg = parseServerMessage(text)

      // Decode any audio parts directly for low-latency playback
      const parts = msg.serverContent?.modelTurn?.parts
      if (parts !== undefined && handlers.onAudio !== undefined) {
        for (const part of parts) {
          if (part.inlineData?.data !== undefined && part.inlineData.data.length > 0) {
            const pcm16 = Buffer.from(part.inlineData.data, 'base64')
            handlers.onAudio(new Uint8Array(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength))
          }
        }
      }

      handlers.onMessage(msg)
    } catch {
      handlers.onError(new Error('received invalid JSON frame from Gemini Live'))
    }
  })

  socket.on('close', (...args: unknown[]) => {
    closed = true
    const reason = typeof args[0] === 'string' ? args[0] : undefined
    handlers.onClose(reason)
  })

  socket.on('error', (err: unknown) => {
    handlers.onError(err instanceof Error ? err : new Error(String(err)))
  })

  return {
    send: (msg: GeminiClientMessage): void => {
      write(JSON.stringify(msg))
    },
    sendAudio: (pcm16_16k: Uint8Array): void => {
      if (pcm16_16k.length === 0) return
      write(JSON.stringify(buildAudioInputMessage(pcm16_16k)))
    },
    close: async (): Promise<void> => {
      if (closed) return
      closed = true
      socket.close()
    },
  }
}
