import { describe, expect, it } from 'vitest'
import { REALTIME_ERROR_CODES } from 'dsh-realtime'
import type { RealtimeDelegation, RealtimeSessionHandlers, RealtimeTranscript, RealtimeUsage } from 'dsh-realtime'
import { GeminiLiveSession } from '../src/session.ts'
import type { GeminiTransport } from '../src/transport.ts'
import type { GeminiClientContentMessage, GeminiClientMessage } from '../src/wire.ts'

class MockTransport implements GeminiTransport {
  readonly sent: GeminiClientMessage[] = []
  readonly sentAudio: Uint8Array[] = []
  closed = false

  send(msg: GeminiClientMessage): void {
    this.sent.push(msg)
  }

  sendAudio(pcm16_16k: Uint8Array): void {
    this.sentAudio.push(pcm16_16k)
  }

  async close(): Promise<void> {
    this.closed = true
  }
}

describe('GeminiLiveSession', () => {
  it('reports started facts with 16 kHz input and 24 kHz output audio formats', () => {
    const transport = new MockTransport()
    const session = new GeminiLiveSession({
      id: 'test-session',
      provider: 'gemini-live',
      model: 'models/gemini-2.0-flash-exp',
      voice: 'Puck',
      transport,
      handlers: {},
    })

    expect(session.id).toBe('test-session')
    expect(session.started.provider).toBe('gemini-live')
    expect(session.started.model).toBe('models/gemini-2.0-flash-exp')
    expect(session.started.voice).toBe('Puck')
    expect(session.started.inputAudio.sampleRate).toBe(16_000)
    expect(session.started.outputAudio.sampleRate).toBe(24_000)
  })

  it('resamples 24 kHz audio to 16 kHz when sending audio', () => {
    const transport = new MockTransport()
    const session = new GeminiLiveSession({
      id: 'test-session',
      provider: 'gemini-live',
      model: 'models/gemini-2.0-flash-exp',
      transport,
      handlers: {},
    })

    // 240 samples of 24 kHz = 480 bytes
    const pcm24k = new Uint8Array(480)
    session.sendAudio(pcm24k)

    expect(transport.sentAudio.length).toBe(1)
    // 240 / 1.5 = 160 samples = 320 bytes (or 318-320 with boundary sample)
    expect(transport.sentAudio[0]!.length).toBeGreaterThanOrEqual(318)
    expect(transport.sentAudio[0]!.length).toBeLessThanOrEqual(320)
  })

  it('drops audio frames when muted, resumes when unmuted', () => {
    const transport = new MockTransport()
    const session = new GeminiLiveSession({
      id: 'test-session',
      provider: 'gemini-live',
      model: 'models/gemini-2.0-flash-exp',
      transport,
      handlers: {},
    })

    session.muteInput()
    session.sendAudio(new Uint8Array(480))
    expect(transport.sentAudio.length).toBe(0)

    session.unmuteInput()
    session.sendAudio(new Uint8Array(480))
    expect(transport.sentAudio.length).toBe(1)
  })

  it('delivers toolResponse when appendCommentary answers a delegationId', async () => {
    const transport = new MockTransport()
    const session = new GeminiLiveSession({
      id: 'test-session',
      provider: 'gemini-live',
      model: 'models/gemini-2.0-flash-exp',
      transport,
      handlers: {},
    })

    await session.appendCommentary('Files edited successfully.', 'call_abc123')
    expect(transport.sent.length).toBe(1)
    const msg = transport.sent[0] as {
      toolResponse: { functionResponses: { id: string; response: { output: { result: string } } }[] }
    }
    expect(msg.toolResponse.functionResponses[0]!.id).toBe('call_abc123')
    expect(msg.toolResponse.functionResponses[0]!.response.output.result).toBe('Files edited successfully.')
  })

  it('drops an audio frame too short to resample rather than sending an empty one', () => {
    const transport = new MockTransport()
    const session = new GeminiLiveSession({
      id: 'test-session',
      provider: 'gemini-live',
      model: 'models/gemini-2.0-flash-exp',
      transport,
      handlers: {},
    })

    session.sendAudio(new Uint8Array(1))

    expect(transport.sentAudio).toEqual([])
  })

  it('delivers clientContent turn when appendCommentary has no delegationId', async () => {
    const transport = new MockTransport()
    const session = new GeminiLiveSession({
      id: 'test-session',
      provider: 'gemini-live',
      model: 'models/gemini-2.0-flash-exp',
      transport,
      handlers: {},
    })

    await session.appendCommentary('User context injection')
    expect(transport.sent.length).toBe(1)
    const msg = transport.sent[0] as GeminiClientContentMessage
    expect(msg.clientContent.turns[0]!.parts[0]!.text).toBe('User context injection')
  })

  it('throws CAPABILITY_UNSUPPORTED when appendThinking is called', async () => {
    const transport = new MockTransport()
    const session = new GeminiLiveSession({
      id: 'test-session',
      provider: 'gemini-live',
      model: 'models/gemini-2.0-flash-exp',
      transport,
      handlers: {},
    })

    await expect(session.appendThinking('silent note')).rejects.toThrow(
      expect.objectContaining({
        code: REALTIME_ERROR_CODES.CAPABILITY_UNSUPPORTED,
      }),
    )
  })

  it('emits onDelegation with structured payload when toolCall arrives', () => {
    const delegations: RealtimeDelegation[] = []
    const handlers: RealtimeSessionHandlers = {
      onDelegation: (d) => delegations.push(d),
    }

    const session = new GeminiLiveSession({
      id: 'test-session',
      provider: 'gemini-live',
      model: 'models/gemini-2.0-flash-exp',
      transport: new MockTransport(),
      handlers,
    })

    session.receive({
      toolCall: {
        functionCalls: [
          {
            id: 'call_99',
            name: 'ask_coding_agent',
            args: { task: 'run git status' },
          },
        ],
      },
    })

    expect(delegations.length).toBe(1)
    expect(delegations[0]!.id).toBe('call_99')
    expect(delegations[0]!.target).toBe('client')
    expect(delegations[0]!.payload).toEqual({ task: 'run git status' })
  })

  it('emits onTranscript when modelTurn text arrives', () => {
    const transcripts: RealtimeTranscript[] = []
    const session = new GeminiLiveSession({
      id: 'test-session',
      provider: 'gemini-live',
      model: 'models/gemini-2.0-flash-exp',
      transport: new MockTransport(),
      handlers: {
        onTranscript: (t) => transcripts.push(t),
      },
    })

    session.receive({
      serverContent: {
        modelTurn: {
          parts: [{ text: 'Here is what changed.' }],
        },
        turnComplete: true,
      },
    })

    expect(transcripts.length).toBe(1)
    expect(transcripts[0]!.kind).toBe('output')
    expect(transcripts[0]!.text).toBe('Here is what changed.')
    expect(transcripts[0]!.final).toBe(true)
  })

  it('emits onError when provider error frame arrives', () => {
    const errors: Error[] = []
    const session = new GeminiLiveSession({
      id: 'test-session',
      provider: 'gemini-live',
      model: 'models/gemini-2.0-flash-exp',
      transport: new MockTransport(),
      handlers: {
        onError: (err) => errors.push(err),
      },
    })

    session.receive({
      error: {
        code: 400,
        message: 'Invalid argument',
      },
    })

    expect(errors.length).toBe(1)
    expect(errors[0]!.message).toContain('Invalid argument')
  })

  it('names a generic failure when an error frame carries no message', () => {
    const errors: Error[] = []
    const session = new GeminiLiveSession({
      id: 'test-session',
      provider: 'gemini-live',
      model: 'models/gemini-2.0-flash-exp',
      transport: new MockTransport(),
      handlers: { onError: (err) => errors.push(err) },
    })

    session.receive({ error: { code: 500 } })

    expect(errors[0]!.message).toBe('Gemini Live error')
  })

  it('ignores an answer for a tool call the model withdrew', async () => {
    const transport = new MockTransport()
    const session = new GeminiLiveSession({
      id: 'test-session',
      provider: 'gemini-live',
      model: 'models/gemini-2.0-flash-exp',
      transport,
      handlers: {},
    })

    // The user barged in: the model stopped speaking and cancelled the call it had asked for.
    session.receive({ toolCallCancellation: { ids: ['call_gone'] } })

    await session.appendCommentary('too late', 'call_gone')
    await session.injectLine('too late', 'call_gone')

    // Nothing is written back: a toolResponse for a call the provider has forgotten is a session
    // error dressed as an append. The delegation still settles upstream; its words just go nowhere.
    expect(transport.sent).toEqual([])
  })

  it('still answers a delegation the model did not withdraw', async () => {
    const transport = new MockTransport()
    const session = new GeminiLiveSession({
      id: 'test-session',
      provider: 'gemini-live',
      model: 'models/gemini-2.0-flash-exp',
      transport,
      handlers: {},
    })

    session.receive({ toolCallCancellation: { ids: ['call_gone'] } })
    await session.appendCommentary('the answer', 'call_still_wanted')
    await session.injectLine('the answer', 'call_still_wanted')

    expect(transport.sent.length).toBe(2)
    expect(transport.sent[0]).toMatchObject({
      toolResponse: { functionResponses: [{ id: 'call_still_wanted' }] },
    })
  })

  it('injects a line as client content when no delegation is named', async () => {
    const transport = new MockTransport()
    const session = new GeminiLiveSession({
      id: 'test-session',
      provider: 'gemini-live',
      model: 'models/gemini-2.0-flash-exp',
      transport,
      handlers: {},
    })

    await session.injectLine('Running the tests now.')

    expect(transport.sent.length).toBe(1)
    const msg = transport.sent[0] as GeminiClientContentMessage
    expect(msg.clientContent.turns[0]!.parts[0]!.text).toBe('Running the tests now.')
  })

  it('prefixes an instruction update so the model reads it as steering, not speech', async () => {
    const transport = new MockTransport()
    const session = new GeminiLiveSession({
      id: 'test-session',
      provider: 'gemini-live',
      model: 'models/gemini-2.0-flash-exp',
      transport,
      handlers: {},
    })

    await session.appendInstructions('be briefer')

    const msg = transport.sent[0] as GeminiClientContentMessage
    expect(msg.clientContent.turns[0]!.parts[0]!.text).toBe('[System Instruction Update]: be briefer')
  })

  it('reports a tool call with no arguments as an empty payload', () => {
    const delegations: RealtimeDelegation[] = []
    const session = new GeminiLiveSession({
      id: 'test-session',
      provider: 'gemini-live',
      model: 'models/gemini-2.0-flash-exp',
      transport: new MockTransport(),
      handlers: { onDelegation: (d) => delegations.push(d) },
    })

    session.receive({ toolCall: { functionCalls: [{ id: 'call_no_args', name: 'ask_coding_agent' }] } })

    expect(delegations[0]!.payload).toEqual({})
  })

  it('reports cumulative usage when the provider sends usage metadata', () => {
    const usages: RealtimeUsage[] = []
    const session = new GeminiLiveSession({
      id: 'test-session',
      provider: 'gemini-live',
      model: 'models/gemini-2.0-flash-exp',
      transport: new MockTransport(),
      handlers: { onUsage: (u) => usages.push(u) },
    })

    session.receive({ usageMetadata: { totalTokenCount: 100 } })

    // The seam reports audio-seconds; Gemini reports tokens. The adapter's own note says this is a
    // proxy, so the test pins the arithmetic rather than pretending the unit is measured.
    expect(usages).toEqual([{ seconds: 2 }])
  })

  it('marks a transcript fragment final only when the turn is complete', () => {
    const transcripts: RealtimeTranscript[] = []
    const session = new GeminiLiveSession({
      id: 'test-session',
      provider: 'gemini-live',
      model: 'models/gemini-2.0-flash-exp',
      transport: new MockTransport(),
      handlers: { onTranscript: (t) => transcripts.push(t) },
    })

    session.receive({ serverContent: { modelTurn: { parts: [{ text: 'half a sen' }] } } })

    expect(transcripts[0]!.final).toBe(false)
  })

  it('goes quiet once closed: audio, appends and inbound frames are all ignored', async () => {
    const transport = new MockTransport()
    const delegations: RealtimeDelegation[] = []
    const session = new GeminiLiveSession({
      id: 'test-session',
      provider: 'gemini-live',
      model: 'models/gemini-2.0-flash-exp',
      transport,
      handlers: { onDelegation: (d) => delegations.push(d) },
    })

    await session.close()
    expect(transport.closed).toBe(true)

    session.sendAudio(new Uint8Array(480))
    await session.appendCommentary('after close', 'call_x')
    await session.appendCommentary('after close')
    await session.injectLine('after close')
    await session.appendInstructions('after close')
    session.receive({ toolCall: { functionCalls: [{ id: 'call_x', name: 'ask_coding_agent' }] } })
    await session.close()

    expect(transport.sentAudio).toEqual([])
    expect(transport.sent).toEqual([])
    expect(delegations).toEqual([])
  })
})
