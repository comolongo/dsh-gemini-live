# Voice Mode for DeepSeek Harness: Gemini Live

A research summary, build record, and living execution log for adding natural, full-duplex voice
conversation to DeepSeek Harness (DSH) using Gemini Live instead of OpenAI.

---

## Current Status: COMPLETE (steps 1–8), pending a live key run
* **Last Updated**: 2026-11-09
* **Base Commit**: `6f78ffc` (`feat(seam): split appAuthoredSpeech — refuse appendCommentary, add injectLine`)
* **Test Baseline at the pin**: 60 test suites, 1,081 tests passing offline with zero credentials.
* **Test Baseline now**: 69 test suites, 1,169 tests passing offline with zero credentials, **per-file
  100% on statements, branches, functions and lines** across `packages/*/src` — the repo's gate, not a
  target.

What is proven and what is not, stated first because the difference matters:

| Claim | Evidence |
|---|---|
| The adapter drives a real session end to end | `GeminiLiveAdapter` + `GeminiLiveSession` run against a fake socket in 81 package tests; a recorded fixture drives the *real* adapter keylessly (`gemini-replay.spec.ts`) |
| The declaration is honoured | The shared conformance suite runs against Gemini as a third subject and reports no divergence |
| The bundle composes without a credential | `cordis.gemini.patch.yml` boots through the real Cordis Loader with both credential variables absent |
| **The wire is correct against Google's server** | **PROVEN 2026-11-09, both paths.** A text turn: setup accepted, `toolCall` with id/name/args, `toolResponse` accepted, 14 audio frames, 4 output-transcription chunks. An audio turn: `inputTranscription` *"Hey, can you hear me?"*, 9 audio frames, 2 output-transcription chunks, and the reply *"Yes, I can hear you clearly."* See §5 for what it did *not* cover |

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

### Protocol re-read, 2026-11-09 — three shapes the first draft had wrong

Re-reading the published Live API reference (ai.google.dev → AI Studio docs) after the build found three
differences that a live socket would have punished, plus a model that no longer exists. All four are now
fixed, and all four are *documented*, not *observed* — the distinction still stands:

1. **The model retired.** `models/gemini-2.0-flash-exp` is gone from the current model list; the Live
   default is **`gemini-3.8-live`** (with `gemini-3.8-live-extended-thinking` and a legacy
   `gemini-3.1-flash-live-preview`). The adapter, the plugin default and the Gemini patch now name
   `models/gemini-3.8-live`. Extended Thinking is deliberately **not** advertised: it requires asynchronous
   function calling (`behavior: NON_BLOCKING` + `scheduling`), and this adapter answers with a blocking
   `toolResponse`.
2. **Audio is `realtimeInput.audio`, not `mediaChunks[]`.** The reference marks `mediaChunks` deprecated and
   says all but the first are ignored. The old frame would have sent audio the server read as an empty
   stream — no error, no speech.
3. **A `FunctionResponse` carries `name` as well as `id`, and `response` is the result object itself**
   (`{ result }`), not an `output` wrapper. The session now learns each call's name from its `toolCall` and
   answers with it; a response without a name cannot be matched to the call that is waiting.
4. **Text on native-audio models is transcription.** They only support the `AUDIO` response modality, so
   `modelTurn.parts[].text` is absent. The setup now enables `outputAudioTranscription` and
   `inputAudioTranscription`, and the session reads `serverContent.outputTranscription` /
   `inputTranscription`. Output transcription is chunked, so the newest chunk is held until the next one
   arrives or the turn completes — the last chunk of a turn is the one marked `final`. That is why the
   declaration is `transcriptDeltas: true`.

Two facts from the same read matter for operations, not code: an audio-only Live session is **capped at 15
minutes** (the server sends `goAway` first, and the socket close surfaces as `onClosed`), and the free tier
is available for `gemini-3.8-live` at no charge, with content used to improve Google's products.

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
node scripts/gemini-probe.mjs  # the first live run: setup → tool call → tool response → transcript
dsh plugin --profile <name> add dsh-openai-live   # mounts cordis.gemini.patch.yml
```

`scripts/gemini-probe.mjs` is the probe the offline suite cannot be: it opens one real session with a text
turn, prints every frame the adapter depends on, and answers the chunked-vs-cumulative transcription
question from §5 by printing the events. It executes nothing — the tool result is a canned string — so it
proves the channel without touching the workspace.

Until the package is published, a profile can mount the checkout directly. `dsh plugin` adds the bundle to
the profile's `dsh.profile.bundles` automatically, and the app applies it on its next load:

```bash
REPO=$PWD
dsh plugin --profile web add \
  "link:$REPO" \
  "link:$REPO/packages/realtime" "link:$REPO/packages/realtime-gemini" \
  "link:$REPO/packages/realtime-agent" "link:$REPO/packages/realtime-responder" \
  "link:$REPO/packages/realtime-audio-ws"
```

Two things that must be true for the mounted bundle to *work*, both learned on the first install:

- **The app's own process needs the key.** The patch reads `GEMINI_API_KEY` from the environment at mount,
  and a process launched before the key existed cannot see it — a session then fails as unconfigured even
  though the probe in a terminal works. Sourcing a private env file from the launcher is one fix.
- **The responder's `sessionId` is live but must be set.** It ships as a placeholder, so `voice_diagnose`
  reports a delegation that nobody would answer until it points at the session you want steered.

The adapter's schema leaves `apiKey` optional on purpose: a profile composes without a key, the
`gemini-live` route registers, and opening a session fails with `MISSING_CREDENTIAL` — naming the
setting, never the value. Set `sessionId` on the responder row to the session you want the voice
conversation to steer; it has no default because a responder attached to the wrong session would speak
another conversation's reply.

---

## 5. The live run, and what it could not cover

**First live session: 2026-11-09**, `scripts/gemini-probe.mjs`, `gemini-3.8-live`, one text turn, no audio
sent. Observed, in order:

- `setupComplete` arrived on the same socket: the `tools` array, `systemInstruction` and both transcription
  configs were accepted as spelled.
- The model called `ask_coding_agent` with `id=call_9677774247773478703`, `name=ask_coding_agent` and
  `args={"task":"Run `git status --short` …"}`.
- The `toolResponse` (id **and** name) was accepted, and the model then spoke: **14 audio frames** at
  24 kHz (3.8–28.8 KB each).
- **4 `outputTranscription` events**, whose text concatenated cleanly into
  *"I have checked the status, and there are no modified or untracked files in the workspace."* — so output
  transcription is **chunked (deltas), not cumulative**, which is what the hold-and-release path and
  `transcriptDeltas: true` assume. This was the open question, and it is now answered by observation.
- `usageMetadata`: `promptTokenCount 718`, `responseTokenCount 123`, `totalTokenCount 841`,
  `thoughtsTokenCount 132`, with `promptTokensDetails` split TEXT 442 / AUDIO 205 and
  `responseTokensDetails` AUDIO 123.

That run also falsified the usage proxy the first draft used. 841 tokens ÷ 50 would have reported **17
seconds** for a turn whose audio ran about two seconds. Usage is now **measured**: bytes carried, divided by
the declared sample rates (`RealtimeUsage.seconds` means what the seam says it means). The frame is still the
trigger; only the number changed.

**Second run, same day — audio input.** `GEMINI_PROBE_AUDIO=/tmp/hello-are-you-there.pcm` (the sample the
Live docs publish, 3.03 s at 16 kHz). The first attempt produced **nothing**: no input transcription, no audio,
no turn. The frames had been sent and the client sat waiting, while the server was still waiting for more
speech — the reference's rule that a paused stream must be ended with `audioStreamEnd`. After sending that
frame the turn completed normally: `inputTranscription` *"Hey, can you hear me?"*, 9 audio frames, two
`outputTranscription` chunks reading *"Yes, I can hear you clearly."*, and usage metadata again. That discovery
is now in the adapter: `muteInput()` flushes the stream, once audio has flowed.

Still unobserved, and named so it is not mistaken for coverage:

1. **The 15-minute audio-only cap and `goAway`.** The reference states both; a probe that ends in twenty
   seconds cannot reach them. Session resumption is not implemented, so a long coding turn can be cut off.
2. **Input transcription at the seam, with the app's own audio.** Observed on the probe's sample clip, so the
   wire path is proven — but not yet through the browser capture → audio route → resampler chain.
3. **The full app path.** The probe exercises the adapter's wire — not the browser capture → audio route →
   session resampler → agent → responder loop. That is `voice_start` plus a spoken turn, and it is the next
   thing to run.
4. **The icon follows the composer's session now; a page without that service does not.** The client face
   reads the app's `uiSession` service and passes the current id on the audio socket (`session=…`), and the
   route steers the responder before opening the voice session. A page that does not mount `uiSession` — the
   fixture beds, or a different host — names no session and the voice keeps following the configured one.
5. **Free-tier rate limits and entitlement refusals.** Which seam code a rate limit maps to
   (`INSUFFICIENT_CREDIT` vs `NOT_ENTITLED` vs a provider error) is unknown until one happens.

Two smaller notes. `toolCallCancellation` handling is defensive — it prevents an answer being written for a
withdrawn call, and its ordering relative to `interrupted` is unobserved. And `gemini-session.jsonl` is still
a hand-written script rather than a capture: the live run confirmed the shapes it encodes, but a trimmed
capture is the honest follow-up (the repository's other fixtures are under a kilobyte, so a raw drain of audio
blobs would need trimming).

---

## 6. How to resume

1. `pnpm install && pnpm test` — the offline suite (1,169 tests) must be green.
2. `pnpm gate` — the full gate, including per-file 100% coverage and the built-artifact smoke.
3. §5 lists what a live run has **not** covered yet — the 15-minute cap, input transcription, and the full
   app path. Record what the next one does in `docs/second-provider-spike.md` (the table that separates ✅
   observed from ❓ documented).
