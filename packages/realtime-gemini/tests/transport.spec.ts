import { describe, expect, it } from 'vitest'
import type { SocketLike } from '../src/transport.ts'
import { openGeminiTransport } from '../src/transport.ts'
import type { GeminiServerMessage } from '../src/wire.ts'

type Listener = (...args: never[]) => void

class FakeSocket implements SocketLike {
  readonly sent: (string | Uint8Array)[] = []
  closes = 0
  private readonly listeners = new Map<string, Listener[]>()

  send(data: string | Uint8Array): void {
    this.sent.push(data)
  }

  close(): void {
    this.closes += 1
  }

  on(event: 'open' | 'message' | 'close' | 'error', listener: Listener): void {
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
  }

  emit(event: string, ...args: unknown[]): void {
    for (const l of this.listeners.get(event) ?? []) (l as (...a: unknown[]) => void)(...args)
  }
}

describe('openGeminiTransport', () => {
  it('buffers frames before open and flushes on open', () => {
    const socket = new FakeSocket()
    const transport = openGeminiTransport(socket, {
      onMessage: () => {},
      onClose: () => {},
      onError: () => {},
    })

    transport.send({ clientContent: { turns: [], turnComplete: true } })
    expect(socket.sent.length).toBe(0)

    socket.emit('open')
    expect(socket.sent.length).toBe(1)
    expect(JSON.parse(socket.sent[0] as string)).toEqual({
      clientContent: { turns: [], turnComplete: true },
    })
  })

  it('decodes base64 audio parts and delivers directly to onAudio', () => {
    const socket = new FakeSocket()
    const audioChunks: Uint8Array[] = []
    const messages: GeminiServerMessage[] = []

    openGeminiTransport(socket, {
      onMessage: (msg) => messages.push(msg),
      onAudio: (pcm) => audioChunks.push(pcm),
      onClose: () => {},
      onError: () => {},
    })

    socket.emit('open')

    const pcm = new Uint8Array([0x12, 0x34, 0x56, 0x78])
    const b64 = Buffer.from(pcm).toString('base64')

    socket.emit(
      'message',
      JSON.stringify({
        serverContent: {
          modelTurn: {
            parts: [
              {
                inlineData: {
                  mimeType: 'audio/pcm;rate=24000',
                  data: b64,
                },
              },
            ],
          },
        },
      }),
    )

    expect(audioChunks.length).toBe(1)
    expect(audioChunks[0]).toEqual(pcm)
    expect(messages.length).toBe(1)
  })

  it('reports invalid JSON as a transport error', () => {
    const socket = new FakeSocket()
    const errors: Error[] = []

    openGeminiTransport(socket, {
      onMessage: () => {},
      onClose: () => {},
      onError: (err) => errors.push(err),
    })

    socket.emit('open')
    socket.emit('message', 'not-valid-json{')

    expect(errors.length).toBe(1)
    expect(errors[0]!.message).toContain('invalid JSON')
  })

  it('notifies onClose when socket closes', () => {
    const socket = new FakeSocket()
    let closedReason: string | undefined

    openGeminiTransport(socket, {
      onMessage: () => {},
      onClose: (reason) => {
        closedReason = reason
      },
      onError: () => {},
    })

    socket.emit('close', 'Normal Closure')
    expect(closedReason).toBe('Normal Closure')
  })

  it('writes audio as a realtimeInput frame, and drops an empty one', () => {
    const socket = new FakeSocket()
    const transport = openGeminiTransport(socket, {
      onMessage: () => {},
      onClose: () => {},
      onError: () => {},
    })
    socket.emit('open')

    transport.sendAudio(new Uint8Array([0x01, 0x02]))
    expect(socket.sent.length).toBe(1)
    expect(JSON.parse(socket.sent[0] as string)).toEqual({
      realtimeInput: {
        mediaChunks: [{ mimeType: 'audio/pcm;rate=16000', data: Buffer.from([0x01, 0x02]).toString('base64') }],
      },
    })

    transport.sendAudio(new Uint8Array(0))
    expect(socket.sent.length).toBe(1)
  })

  it('accepts a binary or an untyped message frame, not only a string', () => {
    const socket = new FakeSocket()
    const messages: unknown[] = []
    openGeminiTransport(socket, {
      onMessage: (msg) => messages.push(msg),
      onClose: () => {},
      onError: () => {},
    })
    socket.emit('open')

    const text = JSON.stringify({ serverContent: { turnComplete: true } })
    socket.emit('message', new Uint8Array(Buffer.from(text, 'utf8')))
    socket.emit('message', Uint8Array.from(Buffer.from(text, 'utf8')).buffer)
    socket.emit('message', 42)

    expect(messages).toHaveLength(3)
    expect(messages[0]).toEqual({ serverContent: { turnComplete: true } })
    expect(messages[1]).toEqual({ serverContent: { turnComplete: true } })
    expect(messages[2]).toEqual(42)
  })

  it('leaves audio undecoded when no onAudio handler is attached, and when a part is empty', () => {
    const socket = new FakeSocket()
    const messages: unknown[] = []
    openGeminiTransport(socket, {
      onMessage: (msg) => messages.push(msg),
      onClose: () => {},
      onError: () => {},
    })
    socket.emit('open')

    socket.emit(
      'message',
      JSON.stringify({
        serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: '' } }] } },
      }),
    )

    expect(messages).toHaveLength(1)
  })

  it('wraps a non-Error socket failure as an Error', () => {
    const socket = new FakeSocket()
    const errors: Error[] = []
    openGeminiTransport(socket, {
      onMessage: () => {},
      onClose: () => {},
      onError: (error) => errors.push(error),
    })

    socket.emit('error', 'socket said no')

    expect(errors[0]!.message).toBe('socket said no')
  })

  it('closes the socket once, and writes nothing afterwards', async () => {
    const socket = new FakeSocket()
    const transport = openGeminiTransport(socket, {
      onMessage: () => {},
      onClose: () => {},
      onError: () => {},
    })
    socket.emit('open')

    await transport.close()
    expect(socket.closes).toBe(1)

    // A send after close is a no-op rather than a throw: the transport cannot know whether the
    // session has noticed the close yet, and throwing here would surface as a session bug.
    transport.sendAudio(new Uint8Array([0x01, 0x02]))
    transport.send({ clientContent: { turns: [], turnComplete: true } })
    expect(socket.sent).toEqual([])

    // The socket's own close event marks the transport closed; closing again must not close twice.
    socket.emit('close', 'done')
    await transport.close()
    expect(socket.closes).toBe(1)
  })
})
