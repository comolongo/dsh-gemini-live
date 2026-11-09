import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { API_KEY_SETTING, apply, Config, DEFAULT_GEMINI_INSTRUCTIONS, inject, name } from '../src/index.ts'
import { GeminiLiveAdapter } from '../src/adapter.ts'

interface Registered {
  routes: readonly string[]
  adapter: unknown
}

function mockContext(): { ctx: Context; secrets: string[][]; registered: Registered[] } {
  const secrets: string[][] = []
  const registered: Registered[] = []
  const ctx = {
    realtime: {
      journal: {
        addSecrets: (values: readonly string[]) => {
          secrets.push([...values])
        },
      },
      registerAdapter: (routes: readonly string[], adapter: unknown) => {
        registered.push({ routes, adapter })
      },
    },
  } as unknown as Context
  return { ctx, secrets, registered }
}

describe('realtime-gemini plugin', () => {
  it('is a function plugin with named exports and no default export', async () => {
    expect(name).toBe('realtime-gemini')
    expect(inject).toEqual(['realtime'])
    const mod = await import('../src/index.ts')
    expect('default' in mod).toBe(false)
  })

  it('names GEMINI_API_KEY as the default credential setting', () => {
    expect(API_KEY_SETTING).toBe('GEMINI_API_KEY')
  })

  it('registers the api key as a journal secret upon apply', () => {
    const { ctx, secrets, registered } = mockContext()
    apply(ctx, { apiKey: 'my-gemini-secret-key' })

    expect(secrets).toEqual([['my-gemini-secret-key']])
    expect(registered.length).toBe(1)
    expect(registered[0]!.routes).toEqual(['gemini-live'])
    expect(registered[0]!.adapter).toBeInstanceOf(GeminiLiveAdapter)
  })

  it('registers empty secret list if no api key is configured', () => {
    const { ctx, secrets } = mockContext()
    apply(ctx, {})
    expect(secrets).toEqual([[]])
  })

  it('allows overriding provider route', () => {
    const { ctx, registered } = mockContext()
    apply(ctx, { provider: 'custom-gemini' })
    expect(registered[0]!.routes).toEqual(['custom-gemini'])
  })

  it('includes default system instructions in Config schema', () => {
    expect(Config).toBeDefined()
    expect(DEFAULT_GEMINI_INSTRUCTIONS).toContain('ask_coding_agent')
    expect(DEFAULT_GEMINI_INSTRUCTIONS).toContain('NEVER read source code, diffs, JSON, URLs, or long logs aloud')
  })

  it('resolves the config defaults a patch can rely on', () => {
    // A patch's `config` replaces the schema's defaults wholesale rather than deep-merging, so what
    // the schema resolves from `{}` is what an unconfigured row actually mounts.
    const resolved = Config({}) as {
      provider: string
      model: string
      voice: string
      instructions: string
      establishTimeoutMs: number
    }
    expect(resolved.provider).toBe('gemini-live')
    expect(resolved.model).toBe('models/gemini-2.0-flash-exp')
    expect(resolved.voice).toBe('Puck')
    expect(resolved.instructions).toBe(DEFAULT_GEMINI_INSTRUCTIONS)
    expect(resolved.establishTimeoutMs).toBe(20_000)
  })
})
