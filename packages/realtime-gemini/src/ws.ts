/**
 * The single network edge that constructs a real WebSocket.
 *
 * @module dsh-realtime-gemini/ws
 */
import WebSocket from 'ws'
import type { SocketLike } from './transport.ts'

export function openWebSocket(url: string): SocketLike {
  return new WebSocket(url) as unknown as SocketLike
}
