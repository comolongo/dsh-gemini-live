# Voice Mode for DeepSeek Harness: Gemini Live

A research summary, build record, and living execution log for adding natural, full-duplex voice
conversation to DeepSeek Harness (DSH) using Gemini Live instead of OpenAI.

---

## Current Status: COMPLETE (steps 1–8), pending a live key run
* **Last Updated**: 2026-11-09
* **Base Commit**: `6f78ffc` (`feat(seam): split appAuthoredSpeech — refuse appendCommentary, add injectLine`)
* **Test Baseline at the pin**: 60 test suites, 1,081 tests passing offline with zero credentials.
* **Test Baseline now**: 69 test suites, 1,160 tests passing offline with zero credentials, **per-file
  100% on statements, branches, functions and lines** across `packages/*/src` — the repo's gate, not a
  target.

What is proven and what is not, stated first because the difference matters:

| Claim | Evidence |
|---|---|
| The adapter drives a real session end to end | `GeminiLiveAdapter` + `GeminiLiveSession` run against a fake socket in 72 package tests; a recorded fixture drives the *real* adapter keylessly (`gemini-replay.spec.ts`) |
| The declaration is honoured | The shared conformance suite runs against Gemini as a third subject and reports no divergence |
| The bundle composes without a credential | `cordis.gemini.patch.yml` boots through the real Cordis Loader with both credential variables absent |
| **The wire is correct against Google's server** | **NOT YET PROVEN.** No run with a real `GEMINI_API_KEY` has happened. Every frame shape below is documented, not observed — the distinction this repo draws everywhere else (ADR-012) applies here with full force |

---

## 1. Goal & Requirements
- Natural back-and-forth full-duplex conversation with the DeepSeek Harness coding agent.
- Interruptible (barge-in via Gemini's own VAD; the adapter never runs a competing boundary).
- Output condensed into short spoken summaries (no reading raw code, diffs, or long logs).
- Works with Gemini Live's free tier (an API key without a paid dependency).
- Tests pass offline without API keys (keyless replay contract, ADR-003).

---

## 2. Architectural Blueprint

```
┌────────────────────────────────────────────────────────────────────────┐
│                        DSH Web Client / Browser                        │
│         mic capture (24 kHz PCM16)  ▲  speaker playback (24 kHz PCM16) │
└─────────────────────────────────────┼──────────────────────────────────┘
                                      ▼
┌────────────────────────────────────────────────────────────────────────┐
│                      dsh-realtime-audio-ws                             │
│                  WebSocket bridge on /dsh-realtime/audio               │
└─────────────────────────────────────┼──────────────────────────────────┘
                                      ▼
┌────────────────────────────────────────────────────────────────────────┐
│              dsh-realtime-gemini (Gemini Live adapter)                 │
│  • Resamples input: 24 kHz -> 16 kHz (3:2 linear resampler)            │
│  • Manages wss://generativelanguage.googleapis.com … BidiGenerateContent│
│  • Declares tool: ask_coding_agent(task)                               │
│  • Barge-in: provider-side VAD; toolCallCancellation is remembered      │
└──────────────────────────┬─────────────────────────────▲───────────────┘
  toolCall:                │                             │ toolResponse:
  ask_coding_agent(task)   ▼                             │ appendCommentary(summary)
┌────────────────────────────────────────────────────────┴───────────────┐
│              dsh-realtime-agent & dsh-realtime-responder               │
│  • Runs DSH Agent: sessionController.prompt(task)                      │
│  • Tools, file access, bash commands, git diffs execution              │
│  • Formats outcome with toSpeech() and returns it as the tool result   │
└────────────────────────────────────────────────────────────────────────┘
```

The one seam change this build required: a delegation can now carry a **structured payload**
(`RealtimeDelegation.payload`). OpenAI's client delegation sends metadata only and the consumer
reconstructs intent from transcripts; Gemini's in-band function calling sends the arguments directly,
so `promptFrom` prefers `payload.task` over the transcript. Everything else is an adapter.

---

## 3. What exists, by step

### [x] Step 1 — Upstream architecture audit
Confirmed the two-row architecture on the seam (`realtime` vs `realtime-agent`/`realtime-responder`) and
named the three seam differences: the delegation payload (tool arguments vs transcript reconstruction),
the answer channel (acknowledged commentary vs in-band `toolResponse`), and the input sample rate
(24 kHz browser capture vs 16 kHz Gemini input).

### [x] Step 2 — Fork, pin, verify baseline
Cloned at `6f78ffc`; offline suite green at 60 files / 1,080 tests before any change.

### [x] Step 3 — Seam isolation and delegation payload
- `RealtimeDelegation.payload?: Readonly<Record<string, unknown>>` — `packages/realtime/src/types.ts`
- `DelegationRequest.payload` — `packages/realtime-agent/src/types.ts`, forwarded in `bridge.ts`
- `promptFrom` prefers `payload.task` over the transcript — `packages/realtime-responder/src/turn.ts`
- Covered by `packages/realtime-responder/tests/turn.spec.ts` and `packages/realtime-agent/tests/bridge.spec.ts`

### [x] Step 4 — `packages/realtime-gemini`
`wire.ts` (setup / realtimeInput / clientContent / toolResponse / serverContent frames), `resample.ts`
(stateful 24 kHz → 16 kHz linear PCM16, phase carried across chunks), `capabilities.ts`,
`transport.ts` (buffers before open; base64 audio decode), `session.ts` (`GeminiLiveSession`),
`adapter.ts` (`GeminiLiveAdapter`), `ws.ts` (the single place a real `WebSocket` is constructed),
`index.ts` (the Cordis plugin).

### [x] Step 5 — Tool bridge
`ask_coding_agent(task: string)` is declared in the setup frame. An inbound `toolCall` becomes a
`RealtimeDelegation` with `payload: { task }` and `target: 'client'`; the answer is written back as
`toolResponse` for the same call id. `toolCallCancellation` is remembered, and an answer for a
withdrawn call is **not** written back — the model no longer knows that id, and a `toolResponse` for it
would surface as a session error. Barge-in itself needs no adapter code: Gemini stops its own speech,
and this adapter never queues audio.

### [x] Step 6 — Spoken-summary instructions
`DEFAULT_GEMINI_INSTRUCTIONS` (adapter schema default) tells the model to delegate with the tool, speak
1–2 sentence summaries, never read code/diffs/JSON/URLs/logs aloud, ask once when a request is
ambiguous, and stop speaking when interrupted. It lives in the **adapter**, not the bundle's agent row:
the brief has to name the tool the adapter declares, and the shared agent row's brief is written for the
GPT-Live-1 protocol ("you have no tools"), which would contradict it. See `cordis.gemini.patch.yml`.

### [x] Step 7 — Conformance and keyless replay
- Gemini is the third subject of `packages/realtime-conformance`; the harness holds the declaration
  against observed behaviour and reports `appAuthoredSpeech`, `injectLine`, `appendThinking`, `inputMute`,
  transcript granularity and prompt-update honesty.
- `packages/realtime-replay/src/gemini.ts` replays a recorded session through the real adapter and
  session, with `tests/fixtures/gemini-session.jsonl` as the recording — transcripts, a `toolCall` with
  a `task` payload, a `toolResponse` write-back and usage metadata, all with no credential.

### [x] Step 8 — Monorepo and bundle integration
- `dsh-realtime-gemini` in the workspace (via `packages/*`), root `package.json` dependency, `dsh/index.js`
  re-export (`geminiLive`), and the vitest alias.
- `cordis.gemini.patch.yml` is the composition a profile mounts for Gemini, and it is what
  `dsh.bundle.patch` now names. `cordis.patch.yml` remains the GPT-Live-1 composition — the two are not
  one patch, for the instruction reason above, and both are exported and shipped.
- Both patches are tested through the real Loader
  (`packages/realtime-gemini/tests/bundle-patch.spec.ts`, `packages/realtime-openai/tests/bundle-patch.spec.ts`).

### Seam defect found by the patch test
Registering a route kept only `id`/`name`/`description`, dropping `configured` and `capabilities`. So
`listProviders()` — the only surface `voice_status` and `voice_diagnose` can read — reported "does not
say whether it is configured" for every route, and `requireCapability` had nothing to read. The registry
now keeps the whole declaration (`packages/realtime/src/index.ts`), and
`packages/realtime/tests/registry.spec.ts` pins it.

---

## 4. How to run it

```bash
pnpm install
pnpm gate                      # leakscan → build → declared-deps → typecheck → coverage → built-artifact smoke
export GEMINI_API_KEY=…        # or GOOGLE_API_KEY; never a file this code reads
dsh plugin --profile <name> add dsh-openai-live   # mounts cordis.gemini.patch.yml
```

The adapter's schema leaves `apiKey` optional on purpose: a profile composes without a key, the
`gemini-live` route registers, and opening a session fails with `MISSING_CREDENTIAL` — naming the
setting, never the value. Set `sessionId` on the responder row to the session you want the voice
conversation to steer; it has no default because a responder attached to the wrong session would speak
another conversation's reply.

---

## 5. Known limits and what the first live run should check

1. **No live session has been opened.** The first thing to do with a key is a single `voice_start` and
   one delegated turn. The three assumptions worth watching, in the order they would hurt:
   - `setupComplete` arrives on the same socket, and the setup frame's `tools`/`systemInstruction` are
     accepted as spelled (a silent drop here would make the model chat but never delegate).
   - `serverContent.modelTurn.parts[].text` carries transcript text under `responseModalities: ['AUDIO']`.
     This is what the adapter reads; **if it does not, captions and the input-transcript journal are
     empty until `outputAudioTranscription` / `inputAudioTranscription` are enabled** — a deliberate
     omission, because enabling them without observing the frames would be a guess with a citation.
   - `usageMetadata.totalTokenCount` is present, and the token→second proxy (`/50`) is at least the
     right order of magnitude. It is a proxy; the seam's `RealtimeUsage.seconds` is defined as audio
     seconds, and this adapter does not yet measure audio duration itself.
2. **`toolCallCancellation` handling is defensive.** It prevents an answer being written for a withdrawn
   call; whether Gemini sends it before or after `interrupted` is unobserved.
3. **Free-tier limits and entitlement** were not probed (no key). `NOT_ENTITLED` / `INSUFFICIENT_CREDIT`
   are the seam's codes; which one a free-tier refusal maps to is unknown until it happens.
4. **The recording is authored, not captured.** `gemini-session.jsonl` mirrors the documented frame
   shapes so the replay path can be tested; replacing it with a captured session is the honest follow-up
   once a key exists.

---

## 6. How to resume

1. `pnpm install && pnpm test` — the offline suite (1,160 tests) must be green.
2. `pnpm gate` — the full gate, including per-file 100% coverage and the built-artifact smoke.
3. Section 5 is the live-run checklist; record what the wire actually did in
   `docs/second-provider-spike.md` (the table that separates ✅ observed from ❓ documented).
