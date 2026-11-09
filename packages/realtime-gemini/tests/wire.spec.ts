import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CODING_TOOL,
  buildAudioInputMessage,
  buildClientContentMessage,
  buildSetupMessage,
  buildToolResponseMessage,
  normalizeModelName,
  parseServerMessage,
} from '../src/wire.ts'

describe('wire protocol builders and parsers', () => {
  it('normalizes model names with models/ prefix', () => {
    expect(normalizeModelName('gemini-2.0-flash-exp')).toBe('models/gemini-2.0-flash-exp')
    expect(normalizeModelName('models/gemini-2.0-flash-exp')).toBe('models/gemini-2.0-flash-exp')
  })

  it('builds a valid setup frame with audio modalities, prebuilt voice, and default tool declaration', () => {
    const setup = buildSetupMessage({
      model: 'gemini-2.0-flash-exp',
      voice: 'Fenrir',
      instructions: 'You are a test voice.',
    })

    expect(setup.setup.model).toBe('models/gemini-2.0-flash-exp')
    expect(setup.setup.generationConfig?.responseModalities).toEqual(['AUDIO'])
    expect(setup.setup.generationConfig?.speechConfig?.voiceConfig?.prebuiltVoiceConfig?.voiceName).toBe('Fenrir')
    expect(setup.setup.systemInstruction?.parts[0]?.text).toBe('You are a test voice.')
    expect(setup.setup.tools?.[0]?.functionDeclarations[0]).toEqual(DEFAULT_CODING_TOOL)
  })

  it('builds a realtime audio input frame base64 encoding 16 kHz PCM bytes', () => {
    const pcm = new Uint8Array([0x00, 0x01, 0x02, 0x03])
    const msg = buildAudioInputMessage(pcm)
    expect(msg.realtimeInput.mediaChunks[0]?.mimeType).toBe('audio/pcm;rate=16000')
    const decoded = Buffer.from(msg.realtimeInput.mediaChunks[0]!.data, 'base64')
    expect(new Uint8Array(decoded)).toEqual(pcm)
  })

  it('builds tool call response messages', () => {
    const msg = buildToolResponseMessage('call_42', 'Operation complete')
    expect(msg.toolResponse.functionResponses[0]).toEqual({
      id: 'call_42',
      response: {
        output: {
          result: 'Operation complete',
        },
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

  it('defaults the voice to Puck when none is asked for', () => {
    const setup = buildSetupMessage({ model: 'gemini-2.0-flash-exp' })
    expect(setup.setup.generationConfig?.speechConfig?.voiceConfig?.prebuiltVoiceConfig?.voiceName).toBe('Puck')
  })

  it('omits the system instruction when the supplied one is blank', () => {
    const setup = buildSetupMessage({ model: 'gemini-2.0-flash-exp', instructions: '   ' })
    expect(setup.setup.systemInstruction).toBeUndefined()
  })

  it('declares caller-supplied tools in place of the default coding tool', () => {
    const custom = { name: 'look_up', description: 'Look something up' } as const
    const setup = buildSetupMessage({ model: 'gemini-2.0-flash-exp', tools: [custom] })
    expect(setup.setup.tools?.[0]?.functionDeclarations).toEqual([custom])
  })
})
