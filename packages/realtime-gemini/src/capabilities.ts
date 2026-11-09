/**
 * Gemini Live capabilities declaration.
 *
 * Grounded in the Gemini Multimodal Live API (BidiGenerateContent over WebSocket), read against the published
 * reference on 2026-11-09:
 *
 * - `appendThinking: false` — Gemini Live has no separate silent thinking channel mid-turn.
 * - `appAuthoredSpeech: true` — when Gemini calls `ask_coding_agent`, DSH runs the task and returns the
 *   result as a `FunctionResponse`; the model then speaks it. The application authored the result — the same
 *   reading ADR-011 gives the delegation answer for a tool-calling provider.
 * - `injectLine: true` — a line can be injected as a `clientContent` turn, which the model says in its own
 *   words. It is what narration uses, and it is the weaker promise.
 * - `functionCalls: true` — native in-band function calling (`toolCall` / `toolResponse`), synchronous unless
 *   the declaration opts into `behavior: NON_BLOCKING`.
 * - `usageReporting: true` — an `usageMetadata` frame triggers a report, but the number reported is
 *   **measured**: the audio the session actually carried, divided by the declared sample rates. The
 *   provider's token count is not audio seconds — the first live run reported 841 tokens for about two
 *   seconds, and a token proxy would have claimed seventeen.
 * - `transcriptDeltas: true` — text arrives as transcription (`serverContent.outputTranscription` /
 *   `inputTranscription`), and the model's side is **chunked**: the newest chunk is held until the next one
 *   arrives or the turn completes, so the final fragment of a turn is the one marked `final`. The user's side
 *   is delivered as the provider sends it (its frequent-update stream is a separate field this adapter ignores).
 * - `inputMute: true` — the adapter stops writing audio frames locally, and flushes what the provider has
 *   already buffered by ending the stream (`audioStreamEnd`), because otherwise the words before a mute can
 *   sit in the server's buffer unanswered.
 * - `promptUpdate: 'append'` — a mid-session instruction update is written as a `clientContent` turn, which the
 *   reference says is appended to the conversation history; it does not replace the opening instruction.
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
  transcriptDeltas: true,
  inputMute: true,
  promptUpdate: 'append',
})
