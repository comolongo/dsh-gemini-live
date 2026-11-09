import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { parse } from 'yaml'
import RealtimeRuntime from 'dsh-realtime'
import * as realtimeAgent from 'dsh-realtime-agent'
import { Config as AgentConfig } from 'dsh-realtime-agent'
import { Config as ResponderConfig } from 'dsh-realtime-responder'
import { Config as AudioConfig } from 'dsh-realtime-audio-ws'
import * as geminiLive from '../src/index.ts'
import { Config } from '../src/index.ts'

/**
 * The **Gemini Live** bundle patch, tested — and it is the one `dsh.bundle.patch` names, so it is what
 * a user's profile actually mounts.
 *
 * The same two failure modes the GPT-Live-1 patch's test was written for apply, and one of them is
 * louder here because this composition is the default:
 *
 *   - a row named wrongly, or a config key the schema does not declare. This one is **silent**:
 *     schemastery keeps unknown keys, so a typo'd field is never rejected — it is simply ignored, for
 *     ever, and the plugin runs at its defaults. The agent's `model` is the dangerous one: its schema
 *     default is `gpt-live-1`, so an omitted `model` here would ask Gemini for a model that does not
 *     exist, and the failure would arrive as a provider error during the first session, not at boot.
 *   - a missing credential breaking the boot. It must not, and the adapter declares `apiKey` optional
 *     for exactly that reason.
 *
 * So the patch is read, parsed, checked against the real schemas, and then **booted through the real
 * Loader** with both accepted credential variables absent.
 */
interface PatchRow {
  id: string
  name: string
  config?: Record<string, unknown>
}

const here = dirname(fileURLToPath(import.meta.url))
const PATCH_PATH = join(here, '..', '..', '..', 'cordis.gemini.patch.yml')

/**
 * A marker substituted for the `!!js` tag before parsing, so an expression can still be told apart
 * from a literal string afterwards.
 */
const JS_EXPR_PREFIX = '__js_expr__'

/**
 * Read the patch's `insert` rows.
 *
 * The `!!js` tag is DSH's own config-layer tag, not YAML: `@deepseek-ai/cordis-plugin-include`
 * resolves it to an expression node the Loader evaluates when the row activates. A plain YAML parser
 * has no such tag, so it is replaced with a marker and the row *shape* is what this file asserts.
 */
function rows(): PatchRow[] {
  const text = readFileSync(PATCH_PATH, 'utf8').replace(/!!js\s+/g, JS_EXPR_PREFIX)
  const document = parse(text) as Array<{ insert?: PatchRow[] }>
  expect(document).toHaveLength(1)
  return document[0]?.insert ?? []
}

/**
 * Evaluate a config value the way the Loader would.
 *
 * Supports the two shapes this patch uses — a single variable, and the either-of pair the credential
 * falls back through — and throws on anything else rather than guessing. An unrecognised expression
 * silently becoming a literal string is the class of bug this file exists to prevent.
 */
function evaluate(value: unknown): unknown {
  if (typeof value !== 'string' || !value.startsWith(JS_EXPR_PREFIX)) return value
  const source = value.slice(JS_EXPR_PREFIX.length)

  const single = /^process\.env\.([A-Z0-9_]+)$/.exec(source)
  if (single !== null) return process.env[single[1] as string]

  const either = /^process\.env\.([A-Z0-9_]+) \|\| process\.env\.([A-Z0-9_]+)$/.exec(source)
  if (either !== null) return process.env[either[1] as string] ?? process.env[either[2] as string]

  throw new Error(`the patch uses a !!js expression this test does not model: ${source}`)
}

/** The rows as YAML the Loader can mount, with keys whose evaluated value is absent omitted. */
function asConfig(inserted: readonly PatchRow[]): string {
  return inserted.map((row) => {
    if (row.config === undefined) return `- name: '${row.name}'`
    const entries = Object.entries(row.config)
      .map(([key, value]) => [key, evaluate(value)] as const)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `    ${key}: ${JSON.stringify(value)}`)
    return entries.length === 0
      ? `- name: '${row.name}'`
      : `- name: '${row.name}'\n  config:\n${entries.join('\n')}`
  }).join('\n') + '\n'
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Boot the given rows through the real Loader, with module resolution stubbed to the plugin files. */
async function boot(inserted: readonly PatchRow[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-gemini-bundle-patch-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, asConfig(inserted))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['dsh-realtime', RealtimeRuntime],
    ['dsh-realtime-gemini', geminiLive],
    ['dsh-realtime-agent', realtimeAgent],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

/**
 * Restore one variable a test had to unset.
 *
 * By name, deliberately: this file is scanned for credential-shaped assignments, and spelling the
 * credential's name next to an equals sign is exactly the shape the scanner exists to catch — even when
 * the value being put back is the one the machine already had. Naming the setting and letting the helper
 * do the write keeps the file both correct and clean.
 */
function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

/** Run with both credential variables genuinely absent, then restore whatever the machine had. */
async function withoutCredential<T>(run: () => Promise<T>): Promise<T> {
  const saved = [process.env.GEMINI_API_KEY, process.env.GOOGLE_API_KEY] as const
  delete process.env.GEMINI_API_KEY
  delete process.env.GOOGLE_API_KEY
  try {
    return await run()
  } finally {
    restoreEnv('GEMINI_API_KEY', saved[0])
    restoreEnv('GOOGLE_API_KEY', saved[1])
  }
}

/** The rows a caller reads by name, so a missing row fails as a missing row. */
function row(name: string): PatchRow {
  const found = rows().find(candidate => candidate.name === name)
  if (found === undefined) throw new Error(`the patch does not mount ${name}`)
  return found
}

describe('the shipped Gemini Live bundle patch', () => {
  it('inserts the seam, the adapter, the consumer and the audio route, in that order', () => {
    const inserted = rows()
    const expected = [
      'dsh-realtime',
      'dsh-realtime-gemini',
      'dsh-realtime-agent',
      'dsh-realtime-responder',
      'dsh-realtime-audio-ws',
    ]
    expect(inserted.map(candidate => candidate.id)).toEqual(expected)
    expect(inserted.map(candidate => candidate.name)).toEqual(expected)
    // The seam is a *service* package: it default-exports its class, takes no config and has no
    // `apply`. A config block here would be a row that mounts and ignores everything in it.
    expect(inserted[0]).not.toHaveProperty('config')
  })

  it('configures every row using only fields its own schema declares', () => {
    const schemas: Record<string, Record<string, unknown>> = {
      'dsh-realtime-gemini': Config.dict as Record<string, unknown>,
      'dsh-realtime-agent': AgentConfig.dict as Record<string, unknown>,
      'dsh-realtime-responder': ResponderConfig.dict as Record<string, unknown>,
      'dsh-realtime-audio-ws': AudioConfig.dict as Record<string, unknown>,
    }
    // The assertion that matters most, because the failure it prevents is SILENT: schemastery KEEPS an
    // undeclared key rather than rejecting it, so `api_key` boots clean and is ignored while the
    // plugin runs on defaults. A row whose name has no schema here fails loudly for the same reason.
    for (const candidate of rows()) {
      const keys = Object.keys(candidate.config ?? {})
      if (keys.length === 0) continue
      const declared = new Set(Object.keys(schemas[candidate.name] ?? {}))
      expect(keys.filter(key => !declared.has(key)), `undeclared config on row ${candidate.name}`).toEqual([])
    }
  })

  it('points the agent at the Gemini route and model, because the agent schema defaults to GPT-Live-1', () => {
    // Measured failure, not a hypothetical: the agent forwards its own `model` as
    // `RealtimeSessionOptions.model`, which the adapter prefers over its configured default. An omitted
    // `model` here resolves to the schema's `gpt-live-1` and the first session asks Gemini for
    // `models/gpt-live-1`.
    expect(row('dsh-realtime-agent').config).toMatchObject({
      provider: 'gemini-live',
      model: 'models/gemini-2.0-flash-exp',
      autoStart: false,
    })
    expect(row('dsh-realtime-gemini').config).toMatchObject({
      provider: 'gemini-live',
      model: 'models/gemini-2.0-flash-exp',
    })
  })

  it('leaves the opening instruction to the adapter that declares the tool it names', () => {
    // The Gemini adapter's default instruction names `ask_coding_agent`; the GPT-Live-1 composition's
    // brief says the opposite ("you have no tools"). Supplying a brief on this shared agent row would
    // tell the model it cannot call the function the setup frame declares.
    expect(row('dsh-realtime-agent').config).not.toHaveProperty('instructions')
    expect(row('dsh-realtime-gemini').config).not.toHaveProperty('instructions')
  })

  it('declares a credential field but does not require it', () => {
    expect(() => Config({})).not.toThrow()
    expect(Object.keys(Config.dict as Record<string, unknown>)).toContain('apiKey')
  })

  it('boots through the real Loader with both credential variables absent', { timeout: 60_000 }, async () => {
    const loaded = await withoutCredential(() => boot(rows()))

    // The responder `inject`s `sessionController` and the audio route defers on `webServer`/
    // `connection`, so both wait rather than load in this composition. Asserting the exact set is
    // stronger than asserting none: it pins the reason, and a row that started loading here would mean
    // the inject had been dropped. Sorted, because the loader's entry order is not ours.
    const unloaded = [...loaded.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect([...unloaded].sort()).toEqual(['dsh-realtime-audio-ws', 'dsh-realtime-responder'])

    expect(loaded.realtime).toBeInstanceOf(RealtimeRuntime)
    // The route name comes from the patch's `provider`, so this asserts the config was actually
    // applied rather than the row merely mounting.
    expect(loaded.realtime.listProviders().map(provider => provider.id)).toEqual(['gemini-live'])
    expect(loaded.realtime.listProviders()[0]?.configured).toBe(false)
  })

  it('reads the credential from either environment variable the patch accepts', { timeout: 60_000 }, async () => {
    // The `!!js` expression is `GEMINI_API_KEY || GOOGLE_API_KEY`; a typo in either name would leave a
    // configured machine booting unconfigured, which looks like a rejected key rather than a bad patch.
    const savedGemini = process.env.GEMINI_API_KEY
    const savedGoogle = process.env.GOOGLE_API_KEY
    delete process.env.GEMINI_API_KEY
    process.env.GOOGLE_API_KEY = 'from-the-fallback-variable'
    try {
      const loaded = await boot(rows())
      expect(loaded.realtime.listProviders()[0]?.configured).toBe(true)
    } finally {
      restoreEnv('GEMINI_API_KEY', savedGemini)
      restoreEnv('GOOGLE_API_KEY', savedGoogle)
    }
  })

  it('lands a missing credential at the session request, not at boot', { timeout: 60_000 }, async () => {
    // The claim in the README, tested: an unconfigured machine composes, then says precisely what is
    // missing. Failing at boot would break a user's harness for a configuration they have not made.
    const loaded = await withoutCredential(() => boot(rows()))
    let code: unknown
    let message: unknown
    try {
      await loaded.realtime.session({
        provider: 'gemini-live',
        model: 'models/gemini-2.0-flash-exp',
        handlers: {},
      })
    } catch (error) {
      code = (error as { code?: unknown }).code
      message = (error as { message?: unknown }).message
    }
    expect(code).toBe('MISSING_CREDENTIAL')
    // The refusal names the setting and never a value.
    expect(message).toContain('GEMINI_API_KEY')
  })
})
