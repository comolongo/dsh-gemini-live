import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CODING_TOOL,
  buildAudioInputMessage,
  buildAudioStreamEndMessage,
  buildClientContentMessage,
  buildSetupMessage,
  buildToolResponseMessage,
  normalizeModelName,
  parseServerMessage,
} from '../src/wire.ts'

describe('wire protocol builders and parsers', () => {
  it('normalizes model names with models/ prefix', () => {
    expect(normalizeModelName('gemini-3.8-live')).toBe('models/gemini-3.8-live')
    expect(normalizeModelName('models/gemini-3.8-live')).toBe('models/gemini-3.8-live')
  })

  it('builds a valid setup frame with audio modalities, prebuilt voice, and default tool declaration', () => {
    const setup = buildSetupMessage({
      model: 'gemini-3.8-live',
      voice: 'Fenrir',
      instructions: 'You are a test voice.',
    })

    expect(setup.setup.model).toBe('models/gemini-3.8-live')
    expect(setup.setup.generationConfig?.responseModalities).toEqual(['AUDIO'])
    expect(setup.setup.generationConfig?.speechConfig?.voiceConfig?.prebuiltVoiceConfig?.voiceName).toBe('Fenrir')
    expect(setup.setup.systemInstruction?.parts[0]?.text).toBe('You are a test voice.')
    expect(setup.setup.tools?.[0]?.functionDeclarations[0]).toEqual(DEFAULT_CODING_TOOL)
    // Text on a native-audio model comes from transcription, so both sides must be asked for or the session
    // is silent in a way no error reports.
    expect(setup.setup.outputAudioTranscription).toEqual({})
    expect(setup.setup.inputAudioTranscription).toEqual({})
  })

  it('builds a realtime audio input frame base64 encoding 16 kHz PCM bytes', () => {
    const pcm = new Uint8Array([0x00, 0x01, 0x02, 0x03])
    const msg = buildAudioInputMessage(pcm)
    // `realtimeInput.audio`, not the deprecated `mediaChunks[]`: the reference says all but the first chunk
    // are ignored, so the old shape would have sent audio the server read as an empty stream.
    expect(msg.realtimeInput.audio.mimeType).toBe('audio/pcm;rate=16000')
    const decoded = Buffer.from(msg.realtimeInput.audio.data, 'base64')
    expect(new Uint8Array(decoded)).toEqual(pcm)
  })

  it('builds tool call response messages with the call’s own function name', () => {
    const msg = buildToolResponseMessage('call_42', 'ask_coding_agent', 'Operation complete')
    // A FunctionResponse is matched to its call by id *and* name, and its `response` is the result object
    // itself — an `output` wrapper has no meaning in the schema.
    expect(msg.toolResponse.functionResponses[0]).toEqual({
      id: 'call_42',
      name: 'ask_coding_agent',
      response: {
        result: 'Operation complete',
      },
    })
  })

  it('builds client content injection messages', () => {
    const msg = buildClientContentMessage('User typed message')
    expect(msg.clientContent.turns[0]).toEqual({
      role: 'user',
      parts: [{ text: 'User typed message' }],
    })
    expect(msg.clientContent.turnComplete).toBe(true)
  })

  it('parses inbound server messages', () => {
    const json = JSON.stringify({
      setupComplete: {},
      serverContent: {
        modelTurn: {
          parts: [{ text: 'Hello' }],
        },
        turnComplete: true,
      },
    })
    const parsed = parseServerMessage(json)
    expect(parsed.setupComplete).toBeDefined()
    expect(parsed.serverContent?.modelTurn?.parts?.[0]?.text).toBe('Hello')
    expect(parsed.serverContent?.turnComplete).toBe(true)
  })

  it('builds the frame that flushes a paused audio stream', () => {
    expect(buildAudioStreamEndMessage()).toEqual({ realtimeInput: { audioStreamEnd: true } })
  })

  it('defaults the voice to Puck when none is asked for', () => {
    const setup = buildSetupMessage({ model: 'gemini-3.8-live' })
    expect(setup.setup.generationConfig?.speechConfig?.voiceConfig?.prebuiltVoiceConfig?.voiceName).toBe('Puck')
  })

  it('omits the system instruction when the supplied one is blank', () => {
    const setup = buildSetupMessage({ model: 'gemini-3.8-live', instructions: '   ' })
    expect(setup.setup.systemInstruction).toBeUndefined()
  })

  it('declares caller-supplied tools in place of the default coding tool', () => {
    const custom = { name: 'look_up', description: 'Look something up' } as const
    const setup = buildSetupMessage({ model: 'gemini-3.8-live', tools: [custom] })
    expect(setup.setup.tools?.[0]?.functionDeclarations).toEqual([custom])
  })
})
