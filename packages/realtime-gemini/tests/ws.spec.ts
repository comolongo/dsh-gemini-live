import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import { openWebSocket } from '../src/ws.ts'

/**
 * `ws.ts` is the **single** place this package constructs a real WebSocket, and this is the only test
 * that proves it works: everything else runs against a fake socket handed in by the adapter's factory.
 *
 * A local server, so nothing leaves the machine and no credential is involved. This is what would catch a
 * `ws` API change, and it is deliberately the whole of the file.
 */
const servers: WebSocketServer[] = []

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map(server => new Promise<void>(resolve => {
    for (const client of server.clients) client.terminate()
    server.close(() => resolve())
  })))
})

const opened = (socket: ReturnType<typeof openWebSocket>): Promise<void> => new Promise((resolve, reject) => {
  socket.on('open', () => resolve())
  socket.on('error', reject)
})

const closed = (socket: ReturnType<typeof openWebSocket>): Promise<void> => new Promise((resolve) => {
  socket.on('close', () => resolve())
})

describe('openWebSocket', () => {
  it('opens a real socket that carries a frame in each direction', async () => {
    const server = new WebSocketServer({ port: 0 })
    servers.push(server)
    const received: string[] = []
    server.on('connection', (socket) => {
      socket.on('message', (data) => {
        received.push(data.toString())
        socket.send(`echo:${data.toString()}`)
      })
    })
    await new Promise<void>((resolve) => server.once('listening', resolve))
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`

    const socket = openWebSocket(url)
    await opened(socket)
    socket.send('setup')

    const echoed: string[] = []
    await new Promise<void>((resolve) => {
      socket.on('message', (data: unknown) => {
        echoed.push(String(data))
        resolve()
      })
    })

    expect(received).toEqual(['setup'])
    expect(echoed).toEqual(['echo:setup'])

    socket.close()
    await closed(socket)
  })
})
