/**
 * Keyless replay socket factory for Gemini Live.
 *
 * Drives the real GeminiLiveAdapter and GeminiLiveSession from a recorded JSONL fixture
 * without network access or API credentials.
 *
 * @module dsh-realtime-replay/gemini
 */

import type { SocketLike } from 'dsh-realtime-gemini'
import type { RecordedFrame } from './types.ts'

export interface ReplaySocket extends SocketLike {
  readonly sent: string[]
  emit(event: string, ...args: unknown[]): void
}

/**
 * Creates a fake socket that replays recorded Gemini Live server events upon setup.
 */
export function createGeminiReplaySocket(recording: readonly RecordedFrame[]): ReplaySocket {
  const sent: string[] = []
  let closed = false
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>()

  const socket: ReplaySocket = {
    sent,
    send(data: string | Uint8Array): void {
      const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8')
      sent.push(text)

      try {
        const parsed = JSON.parse(text) as Record<string, unknown>
        if (parsed['setup'] !== undefined) {
          setTimeout(() => {
            if (closed) return
            socket.emit('message', JSON.stringify({ setupComplete: {} }))
            for (const frame of recording) {
              if (closed) return
              socket.emit('message', JSON.stringify(frame.event))
            }
          }, 0)
        }
      } catch {
        // Ignore binary or non-JSON payloads
      }
    },
    close(): void {
      if (closed) return
      closed = true
      socket.emit('close')
    },
    on(event: 'open' | 'message' | 'close' | 'error', listener: (...args: never[]) => void): void {
      const list = listeners.get(event) ?? []
      list.push(listener as (...args: unknown[]) => void)
      listeners.set(event, list)
    },
    emit(event: string, ...args: unknown[]): void {
      for (const listener of listeners.get(event) ?? []) listener(...args)
    },
  }

  setTimeout(() => {
    if (!closed) socket.emit('open')
  }, 0)

  return socket
}
