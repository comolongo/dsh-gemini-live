import { describe, expect, it } from 'vitest'
import { REALTIME_ERROR_CODES, RealtimeError } from 'dsh-realtime'
import { GEMINI_LIVE_ENDPOINT, GeminiLiveAdapter } from '../src/adapter.ts'
import type { GeminiAdapterConfig } from '../src/adapter.ts'
import type { SocketLike } from '../src/transport.ts'

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

describe('GeminiLiveAdapter', () => {
  it('reports providerInfo with declared capabilities and configured flag', () => {
    const adapterUnconfigured = new GeminiLiveAdapter({}, () => new FakeSocket())
    const infoUnconfigured = adapterUnconfigured.providerInfo('gemini-live')
    expect(infoUnconfigured.id).toBe('gemini-live')
    expect(infoUnconfigured.name).toBe('Gemini Live')
    expect(infoUnconfigured.configured).toBe(false)
    expect(infoUnconfigured.capabilities?.functionCalls).toBe(true)
    expect(infoUnconfigured.capabilities?.appAuthoredSpeech).toBe(true)

    const adapterConfigured = new GeminiLiveAdapter({ apiKey: 'test-key-123' }, () => new FakeSocket())
    expect(adapterConfigured.providerInfo('gemini-live').configured).toBe(true)
  })

  it('lists advertised voice models', async () => {
    const adapter = new GeminiLiveAdapter({}, () => new FakeSocket())
    const models = await adapter.listModels()
    expect(models.length).toBeGreaterThan(0)
    expect(models.some((m) => m.id === 'gemini-3.8-live')).toBe(true)
  })

  it('throws MISSING_CREDENTIAL when session() is called with no apiKey', async () => {
    const adapter = new GeminiLiveAdapter({}, () => new FakeSocket())
    await expect(
      adapter.session({
        provider: 'gemini-live',
        model: 'gemini-3.8-live',
      }),
    ).rejects.toThrow(
      expect.objectContaining({
        code: REALTIME_ERROR_CODES.MISSING_CREDENTIAL,
      }),
    )
  })

  it('establishes a live session when setupComplete arrives', async () => {
    let openedUrl = ''
    const socket = new FakeSocket()
    const adapter = new GeminiLiveAdapter(
      {
        apiKey: 'secret-gemini-key',
        model: 'models/gemini-3.8-live',
        voice: 'Aoede',
      },
      (url) => {
        openedUrl = url
        return socket
      },
    )

    const sessionPromise = adapter.session({
      provider: 'gemini-live',
      model: 'models/gemini-3.8-live',
    })

    expect(openedUrl).toContain(GEMINI_LIVE_ENDPOINT)
    expect(openedUrl).toContain('key=secret-gemini-key')

    // Socket connects
    socket.emit('open')
    // Adapter should have sent setup message
    expect(socket.sent.length).toBe(1)
    const setupJson = JSON.parse(socket.sent[0] as string)
    expect(setupJson.setup.model).toBe('models/gemini-3.8-live')
    expect(setupJson.setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe('Aoede')

    // Gemini replies with setupComplete
    socket.emit('message', JSON.stringify({ setupComplete: {} }))

    const session = await sessionPromise
    expect(session.id).toBeDefined()
    expect(session.started.provider).toBe('gemini-live')
    expect(session.started.voice).toBe('Aoede')
  })

  it('fails establishment when provider returns error frame', async () => {
    const socket = new FakeSocket()
    const adapter = new GeminiLiveAdapter(
      {
        apiKey: 'invalid-key',
      },
      () => socket,
    )

    const sessionPromise = adapter.session({
      provider: 'gemini-live',
      model: 'models/gemini-3.8-live',
    })

    socket.emit('open')
    socket.emit(
      'message',
      JSON.stringify({
        error: {
          code: 403,
          message: 'API_KEY_INVALID: The provided API key is expired or invalid.',
        },
      }),
    )

    await expect(sessionPromise).rejects.toThrow(
      expect.objectContaining({
        code: REALTIME_ERROR_CODES.PROVIDER_ERROR,
      }),
    )
  })

  it('names a generic setup failure when the provider error frame carries no message', async () => {
    const socket = new FakeSocket()
    const adapter = new GeminiLiveAdapter({ apiKey: 'key' }, () => socket)
    const pending = adapter.session({ provider: 'gemini-live', model: 'models/gemini-3.8-live' })
    socket.emit('open')
    socket.emit('message', JSON.stringify({ error: { code: 400 } }))

    await expect(pending).rejects.toThrow(
      expect.objectContaining({
        code: REALTIME_ERROR_CODES.PROVIDER_ERROR,
        message: 'Gemini rejected the session setup',
      }),
    )
  })

  it('times out if setupComplete never arrives within establishTimeoutMs', async () => {
    const socket = new FakeSocket()
    const adapter = new GeminiLiveAdapter(
      {
        apiKey: 'some-key',
        establishTimeoutMs: 50,
      },
      () => socket,
    )

    const sessionPromise = adapter.session({
      provider: 'gemini-live',
      model: 'models/gemini-3.8-live',
    })

    socket.emit('open')

    await expect(sessionPromise).rejects.toThrow(
      expect.objectContaining({
        code: REALTIME_ERROR_CODES.PROVIDER_TIMEOUT,
      }),
    )
  })

  it('refuses to open when the caller has already abandoned the session', async () => {
    const adapter = new GeminiLiveAdapter({ apiKey: 'key' }, () => new FakeSocket())
    const controller = new AbortController()
    controller.abort()

    await expect(
      adapter.session({
        provider: 'gemini-live',
        model: 'models/gemini-3.8-live',
        signal: controller.signal,
      }),
    ).rejects.toThrow(expect.objectContaining({ code: REALTIME_ERROR_CODES.NETWORK }))
  })

  it('trims a key that arrived with surrounding whitespace, and reports none when it is blank', async () => {
    let openedUrl = ''
    const socket = new FakeSocket()
    const adapter = new GeminiLiveAdapter({ apiKey: '  padded-key  ' }, (url) => {
      openedUrl = url
      return socket
    })

    const opened = adapter.session({ provider: 'gemini-live', model: 'models/gemini-3.8-live' })
    socket.emit('open')
    socket.emit('message', JSON.stringify({ setupComplete: {} }))
    await opened

    expect(openedUrl).toContain('key=padded-key')

    // A whitespace-only key is no key: the route is not configured, and a session request says so
    // rather than opening a socket that the provider would reject.
    const blank = new GeminiLiveAdapter({ apiKey: '   ' }, () => new FakeSocket())
    expect(blank.providerInfo('gemini-live').configured).toBe(false)
  })

  it('honours a configured endpoint instead of the default', async () => {
    let openedUrl = ''
    const socket = new FakeSocket()
    const adapter = new GeminiLiveAdapter({ apiKey: 'key', endpoint: 'wss://example.test/live' }, (url) => {
      openedUrl = url
      return socket
    })

    const opened = adapter.session({ provider: 'gemini-live', model: 'models/gemini-3.8-live' })
    socket.emit('open')
    socket.emit('message', JSON.stringify({ setupComplete: {} }))
    await opened

    expect(openedUrl).toBe('wss://example.test/live?key=key')
  })

  it('falls back to the configured model and voice, then to the defaults', async () => {
    const openWith = async (
      config: Partial<GeminiAdapterConfig>,
      options: { model: string; voice?: string },
    ) => {
      const socket = new FakeSocket()
      const adapter = new GeminiLiveAdapter({ apiKey: 'key', ...config }, () => socket)
      const opened = adapter.session({ provider: 'gemini-live', ...options })
      socket.emit('open')
      socket.emit('message', JSON.stringify({ setupComplete: {} }))
      return opened
    }

    // `''` is what an empty input field resolves to; the adapter must not send it as a model id.
    const fromConfig = await openWith({ model: 'models/configured', voice: 'Kore' }, { model: '' })
    expect(fromConfig.started.model).toBe('models/configured')
    expect(fromConfig.started.voice).toBe('Kore')

    const fromDefaults = await openWith({}, { model: '', voice: '' })
    expect(fromDefaults.started.model).toBe('models/gemini-3.8-live')
    expect(fromDefaults.started.voice).toBe('Puck')
  })

  it('sends no system instruction when the caller supplies only whitespace', async () => {
    const socket = new FakeSocket()
    const adapter = new GeminiLiveAdapter({ apiKey: 'key' }, () => socket)
    const opened = adapter.session({
      provider: 'gemini-live',
      model: 'models/gemini-3.8-live',
      instructions: '   ',
    })
    socket.emit('open')
    const setup = JSON.parse(socket.sent[0] as string)
    expect(setup.setup.systemInstruction).toBeUndefined()

    socket.emit('message', JSON.stringify({ setupComplete: {} }))
    await opened
  })

  it('forwards decoded audio frames to the session handlers', async () => {
    const socket = new FakeSocket()
    const audio: Uint8Array[] = []
    const adapter = new GeminiLiveAdapter({ apiKey: 'key' }, () => socket)

    const opened = adapter.session({
      provider: 'gemini-live',
      model: 'models/gemini-3.8-live',
      handlers: { onAudio: (pcm) => audio.push(pcm) },
    })
    socket.emit('open')
    socket.emit('message', JSON.stringify({ setupComplete: {} }))
    await opened

    const pcm = new Uint8Array([1, 2, 3, 4])
    socket.emit(
      'message',
      JSON.stringify({
        serverContent: {
          modelTurn: {
            parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: Buffer.from(pcm).toString('base64') } }],
          },
        },
      }),
    )

    expect(audio).toHaveLength(1)
    expect(audio[0]).toEqual(pcm)
  })

  it('reports a close before establishment, with the provider reason only when it gave one', async () => {
    const socket = new FakeSocket()
    const adapter = new GeminiLiveAdapter({ apiKey: 'key' }, () => socket)
    const pending = adapter.session({ provider: 'gemini-live', model: 'models/gemini-3.8-live' })
    socket.emit('open')
    socket.emit('close', 'boom')
    await expect(pending).rejects.toThrow(
      expect.objectContaining({
        code: REALTIME_ERROR_CODES.NETWORK,
        message: expect.stringContaining('closed before establishment: boom'),
      }),
    )

    const silentSocket = new FakeSocket()
    const silentAdapter = new GeminiLiveAdapter({ apiKey: 'key' }, () => silentSocket)
    const silent = silentAdapter.session({ provider: 'gemini-live', model: 'models/gemini-3.8-live' })
    silentSocket.emit('open')
    silentSocket.emit('close')
    await expect(silent).rejects.toThrow(
      expect.objectContaining({ code: REALTIME_ERROR_CODES.NETWORK }),
    )
  })

  it('wraps a non-Error socket failure, and passes a coded one through unchanged', async () => {
    const socket = new FakeSocket()
    const adapter = new GeminiLiveAdapter({ apiKey: 'key' }, () => socket)
    const pending = adapter.session({ provider: 'gemini-live', model: 'models/gemini-3.8-live' })
    socket.emit('open')
    socket.emit('error', 'socket exploded')

    await expect(pending).rejects.toThrow(
      expect.objectContaining({ code: REALTIME_ERROR_CODES.NETWORK }),
    )
  })

  it('contains a post-establishment socket failure and reports it, rather than throwing', async () => {
    const socket = new FakeSocket()
    const errors: Error[] = []
    let closedReason: string | undefined
    const adapter = new GeminiLiveAdapter({ apiKey: 'key' }, () => socket)

    const opened = adapter.session({
      provider: 'gemini-live',
      model: 'models/gemini-3.8-live',
      handlers: {
        onError: (error) => errors.push(error),
        onClosed: (reason) => {
          closedReason = reason
        },
      },
    })
    socket.emit('open')
    socket.emit('message', JSON.stringify({ setupComplete: {} }))
    await opened

    socket.emit('error', new Error('transport died'))
    // A failure that is already coded passes through with its code intact: re-wrapping it would
    // destroy the only part a caller branches on.
    const coded = new RealtimeError('already coded', REALTIME_ERROR_CODES.INSUFFICIENT_CREDIT)
    socket.emit('error', coded)
    socket.emit('close', 'provider hung up')

    expect(errors).toHaveLength(2)
    expect(errors[0]!.message).toBe('transport died')
    expect(errors[1]).toBe(coded)
    expect(closedReason).toBe('provider hung up')
  })
})
