/**
 * The Cordis plugin — Gemini Live on the `dsh-realtime` seam.
 *
 * A **function plugin** exporting name / inject / Config / apply with no default export.
 *
 * @module dsh-realtime-gemini
 */

import Schema from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { GeminiLiveAdapter } from './adapter.ts'
import { openWebSocket } from './ws.ts'

export * from './capabilities.ts'
export * from './adapter.ts'
export * from './session.ts'
export * from './transport.ts'
export * from './resample.ts'
export * from './wire.ts'

/** Plugin name, as it appears in Loader diagnostics. */
export const name = 'realtime-gemini'

/** This plugin registers onto the realtime seam, so it waits for it. */
export const inject = ['realtime']

/** Standard environment variable name for the API key. */
export const API_KEY_SETTING = 'GEMINI_API_KEY'

export const DEFAULT_GEMINI_INSTRUCTIONS = `You are the voice interface for DeepSeek Harness (dsh), an agentic coding assistant.
Your job is to hold a natural, concise, full-duplex spoken conversation with the developer.

RULES:
1. When the user asks you to write code, inspect files, run tests, execute terminal commands, or check workspace status, ALWAYS call the tool \`ask_coding_agent\` with the exact task description.
2. When the tool returns a result, speak a concise 1-2 sentence spoken summary of what was done.
3. NEVER read source code, diffs, JSON, URLs, or long logs aloud. State the outcome (e.g., "The tests passed with 14 assertions" or "I fixed the typo in adapter.ts") and inform the user they can see the details in their DSH editor.
4. If a request is ambiguous, ask a brief clarifying question before delegating.
5. If the user interrupts you while speaking, stop talking immediately.`

export const Config = Schema.object({
  apiKey: Schema.string().description(`Gemini API key; supply from ${API_KEY_SETTING} or GOOGLE_API_KEY`),
  provider: Schema.string().default('gemini-live').description('Provider route to register on the seam'),
  model: Schema.string().default('models/gemini-2.0-flash-exp').description('Gemini Live model'),
  voice: Schema.string().default('Puck').description('Prebuilt voice: Puck, Charon, Kore, Fenrir, Aoede'),
  instructions: Schema.string().default(DEFAULT_GEMINI_INSTRUCTIONS).description('System instructions'),
  establishTimeoutMs: Schema.number().default(20_000).description('Bound on waiting for setupComplete'),
})

export interface GeminiPluginConfig {
  readonly apiKey?: string
  readonly provider?: string
  readonly model?: string
  readonly voice?: string
  readonly instructions?: string
  readonly establishTimeoutMs?: number
}

export function apply(ctx: Context, config: GeminiPluginConfig = {}): void {
  const secrets = config.apiKey !== undefined && config.apiKey.length > 0 ? [config.apiKey] : []
  ctx.realtime.journal.addSecrets(secrets)

  const provider = config.provider ?? 'gemini-live'
  ctx.realtime.registerAdapter(
    [provider],
    new GeminiLiveAdapter(
      {
        ...(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
        model: config.model ?? 'models/gemini-2.0-flash-exp',
        voice: config.voice ?? 'Puck',
        instructions: config.instructions ?? DEFAULT_GEMINI_INSTRUCTIONS,
        establishTimeoutMs: config.establishTimeoutMs ?? 20_000,
      },
      openWebSocket,
    ),
  )
}
