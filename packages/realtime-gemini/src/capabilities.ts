/**
 * Gemini Live capabilities declaration.
 *
 * Grounded in the Gemini Multimodal Live API (BidiGenerateContent over WebSocket):
 *
 * - `appendThinking: false` — Gemini Live has no separate silent thinking channel mid-turn.
 * - `appAuthoredSpeech: true` — when Gemini calls `ask_coding_agent`, DSH runs the task and
 *   returns the result via `toolResponse`, which Gemini then speaks.
 * - `injectLine: true` — client can inject user/context turns via `clientContent`.
 * - `functionCalls: true` — native in-band function/tool calling (`toolCall` / `toolResponse`).
 * - `usageReporting: true` — reported in server `usageMetadata` frames.
 * - `transcriptDeltas: false` — whole utterance transcript chunks in `serverContent.modelTurn`.
 * - `inputMute: true` — adapter stops writing audio frames locally.
 * - `promptUpdate: 'append'` — mid-session instructions or context appended via `clientContent`.
 *
 * @module dsh-realtime-gemini/capabilities
 */
import type { RealtimeCapabilities } from 'dsh-realtime'

export const GEMINI_CAPABILITIES: RealtimeCapabilities = Object.freeze({
  appendThinking: false,
  appAuthoredSpeech: true,
  injectLine: true,
  functionCalls: true,
  usageReporting: true,
  transcriptDeltas: false,
  inputMute: true,
  promptUpdate: 'append',
})
