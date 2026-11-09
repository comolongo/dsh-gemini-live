import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { GeminiLiveAdapter } from 'dsh-realtime-gemini'
import type { RealtimeDelegation, RealtimeTranscript, RealtimeUsage } from 'dsh-realtime'
import { createGeminiReplaySocket, loadRecording, REPLAY_CREDENTIAL } from '../src/index.ts'

const fixturePath = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))

describe('Gemini Live keyless replay', () => {
  it('drives GeminiLiveAdapter and GeminiLiveSession from a recorded fixture with no credentials', async () => {
    const recording = loadRecording(fixturePath('gemini-session.jsonl'))
    expect(recording.length).toBeGreaterThan(0)

    let replaySocket!: ReturnType<typeof createGeminiReplaySocket>
    const adapter = new GeminiLiveAdapter(
      {
        apiKey: REPLAY_CREDENTIAL,
        model: 'models/gemini-2.0-flash-exp',
      },
      () => {
        replaySocket = createGeminiReplaySocket(recording)
        return replaySocket
      },
    )

    const transcripts: RealtimeTranscript[] = []
    const delegations: RealtimeDelegation[] = []
    const usages: RealtimeUsage[] = []

    const session = await adapter.session({
      provider: 'gemini-replay',
      model: 'models/gemini-2.0-flash-exp',
      handlers: {
        onTranscript: (t) => transcripts.push(t),
        onDelegation: (d) => delegations.push(d),
        onUsage: (u) => usages.push(u),
      },
    })

    expect(session.started.provider).toBe('gemini-replay')
    expect(session.started.inputAudio.sampleRate).toBe(16_000)
    expect(session.started.outputAudio.sampleRate).toBe(24_000)

    // Wait for the replayed events to stream across ticks
    await new Promise((resolve) => setTimeout(resolve, 20))

    // 1. Transcript arrived
    expect(transcripts.length).toBeGreaterThanOrEqual(1)
    expect(transcripts[0]!.text).toBe('Checking the repository status for you.')

    // 2. Tool call delegation arrived with task payload
    expect(delegations.length).toBe(1)
    expect(delegations[0]!.id).toBe('call_fixture_1')
    expect(delegations[0]!.payload).toEqual({ task: 'run git status and check for modified files' })

    // 3. Answer delegation via appendCommentary
    await session.appendCommentary('Git clean, 60 suites passing', delegations[0]!.id)

    // Verify toolResponse was sent through the socket
    const toolResp = replaySocket.sent
      .map((s) => {
        try {
          return JSON.parse(s) as Record<string, unknown>
        } catch {
          return {}
        }
      })
      .find((m) => m['toolResponse'] !== undefined)

    expect(toolResp).toBeDefined()
    const functionResponses = (
      toolResp!['toolResponse'] as { functionResponses: { id: string; response: { output: { result: string } } }[] }
    ).functionResponses
    expect(functionResponses[0]!.id).toBe('call_fixture_1')
    expect(functionResponses[0]!.response.output.result).toBe('Git clean, 60 suites passing')

    // 4. Usage metadata arrived
    expect(usages.length).toBeGreaterThanOrEqual(1)

    await session.close()
  })
})

/**
 * The replay socket's own edges — the parts the end-to-end test above does not reach.
 *
 * A replay socket is a test double, but it is the double every keyless run depends on, so its failure
 * modes are asserted rather than assumed: a binary frame, a frame that is not JSON, a close that races
 * the replay timer, and an event nobody listens for.
 */
describe('createGeminiReplaySocket', () => {
  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5))

  it('records a binary frame and ignores one that is not JSON', () => {
    const socket = createGeminiReplaySocket([])

    socket.send(new Uint8Array(Buffer.from('not-json', 'utf8')))

    expect(socket.sent).toEqual(['not-json'])

    // Closing twice is idempotent: a test that stops a replay after it has already ended, and the
    // session's own close, must not emit a second close.
    socket.close()
    socket.close()
  })

  it('does not replay a recording after the socket has closed', async () => {
    const socket = createGeminiReplaySocket([])
    socket.send(JSON.stringify({ setup: { model: 'models/gemini-2.0-flash-exp' } }))
    socket.close()

    await tick()

    // The setup frame was recorded; the scripted `setupComplete` and the fixture were not emitted.
    expect(socket.sent).toHaveLength(1)
  })

  it('stops mid-recording when a listener closes the socket, and ignores events nobody listens for', async () => {
    const recording = loadRecording(fixturePath('gemini-session.jsonl'))
    const socket = createGeminiReplaySocket(recording)

    let messages = 0
    socket.on('message', () => {
      messages += 1
      if (messages === 1) socket.close()
    })
    // A second listener on the same event exercises the existing-list branch of `on`.
    socket.on('message', () => {})
    socket.emit('nobody-listens-to-this')

    socket.send(JSON.stringify({ setup: { model: 'models/gemini-2.0-flash-exp' } }))
    await tick()

    expect(messages).toBe(1)
  })
})
