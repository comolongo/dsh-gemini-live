# Decision record

Short ADRs. Each states the decision, the reason, and what it costs. Status: **accepted** unless
marked otherwise.

---

## ADR-001 — Client delegation, not Responses delegation

**Decision.** The plugin uses `delegation: {type: "client"}`.

**Why.** DSH is an external agent with its own models, tools and permissions. Client delegation is
the mode the protocol defines for exactly that: *your application runs the work and returns the
result*. Responses delegation asks OpenAI to run the backend instead, which would put a second
orchestrator beside DSH and make DSH's permissions advisory rather than authoritative.

**Cost.** We own the delegation loop, the context assembly and the 500-token budget. In exchange we
own permissions — which is the whole point.

**Consequence for the contract.** The v8→v9 bump carries the **client** vocabulary
(`commentary`/`thinking`/`instructions` appends, `delegation.created`, usage/closed). The
`response.*` family is a **separate capability** and must be scoped as its own story if ever built.

**Supersedes.** An earlier assumption that the round trip ran through `response.event`. Verified
live: `response.item.create` fails with *"requires Responses delegation"*, and `response.event` is a
server→client envelope exclusive to the Responses path.

---

## ADR-002 — Two rows: a provider and a consumer

**Decision.** `openai-live` (provider) and `openai-live-agent` (delegation consumer) are separate
rows on one seam.

**Why.** They fail independently and are configured independently. Bundling them would force a DSH
user who wants voice-but-not-delegation to carry the agent wiring anyway.

**Cost.** Two rows to version and test, and a contract bump to carry the seam.

---

## ADR-003 — Keyless replay as the CI contract

**Decision.** Conformance runs against recorded session fixtures and must pass with no API key.

**Why.** A test suite that needs a live key cannot run on a fork, cannot run on a contributor's
machine, and — as this build demonstrated within hours — stops entirely when the org's credit
balance hits zero. A gate that can be switched off by a billing event is not a gate.

**Cost.** Fixtures must be recorded, curated, and kept free of anything sensitive — which is
invariant 3 and invariant 5 working together.

---

## ADR-004 — No hand-rolled VAD

**Decision.** Endpointing is the engine's. The plugin never decides when an utterance has ended.

**Why.** It was a design rule first, and the spike proved the protocol enforces it: there is no
`session.input_audio.commit` event. A client-side VAD would be a second, competing turn detector.

**Cost.** Less control over turn latency. Accepted — a wrong detector is worse than a slow one.

---

## ADR-005 — Credentials as a tested invariant

**Decision.** A test proves no credential can reach a log, fixture, transcript or tarball.

**Why.** The plugin's whole job is to hold a live session, so credentials flow through every code
path it has. Review does not scale to that; a planted-string test does.

**Cost.** The mechanism must be built (W4) rather than assumed.

---

## ADR-006 — Upstream contribution over a private fork

**Decision.** Work toward an upstream PR, with acceptance criteria, rather than maintaining a fork.

**Why.** The ecosystem has a plugin targeting the *sunsetting* `gpt-realtime` family at the wrong
endpoint. The durable fix is upstream, not private.

**Cost.** Upstream review latency, and a design that must be acceptable to maintainers we do not
control.

**Amendment (2026-10-09) — the reason was half-right.** It was checked against the plugin's own
source. `AlexKaiqi/dsh-realtime-voice` registers `routeId: 'openai/gpt-realtime'`, so *the sunsetting
family* is confirmed; *the wrong endpoint* is not — it calls official `https://api.openai.com`, pins
that origin, and carries a second vendor (Doubao) alongside. The decision stands; its stated reason
does not, and the strategy should not be defended with an argument the evidence will not carry. Full
comparison: [competitive-landscape.md](competitive-landscape.md).

---

## ADR-007 — Non-governed: a standalone product repo

**Decision.** `dsh-openai-live` is built as a standalone product repository with **its own** gates
(secret scan before first push, tarball inspection before publish, keyless-replay CI). It is not run
as a governed Forge sprint.

**Why.** Three reasons, in order of weight:

1. **Scope.** The Forge vault governs *the Forge platform*. A DSH plugin is neither the platform nor
   vault content. Governance was volunteered onto this project; it was scoped back off by the CEO,
   not by the agent.
2. **Capability.** The governed pipeline cannot execute a code build — the worker's terminal is
   withdrawn, the orchestrator's is disabled, and the mechanism that would restore it is unbuilt and
   itself blocked behind an inactive sprint. A governance path that cannot execute is not a slower
   path; it is a stopped one.
3. **Separation of duty.** The sprint machinery holds a single active-sprint slot, occupied by an
   unrelated infrastructure cutover. A product should not be hostage to that.

**What is *not* decided here.** This is not a claim that governance is optional. The substantive
controls the review produced are kept — they are why there are invariants in
[design.md](design.md) and why the two irreversible acts still have gates. Only the *machinery* is
dropped.

**Reversal.** If the artifact is later brought under Forge, it enters as a **verification** sprint
over a built artifact — which is what that machinery is genuinely good at.

---

## ADR-008 — A file nothing reads is not a contract

**Decision.** This bundle does not ship the ecosystem's `plugin-spec.json` or
`spec/runtime-contract.json`, and no convention is adopted here until the thing that *consumes* it
has been found.

**Why.** A competing bundle ships both, and they make it look formal — which is precisely the
attraction. Neither is consumed: a grep over the harness's `packages/` and `docs/` finds them
nowhere, the installed market plugin (`safer-dsh-market`) does not read them, the official authoring
docs do not mention them, and `gh search code "plugin-spec.json"` returns only unrelated ecosystems
(ToolJet, elizaOS). They pass no gate, catch no drift, and register nothing.

Copying them would be cargo-culting — the appearance of rigour standing in for it — in a repository
whose entire thesis is that a check has to bite. The same instinct that produced this project's leak
scan ("every pattern unambiguous by construction, no allow-list") rejects it: before adding a
convention, find the reader.

**Cost.** We look less decorated beside a bundle that ships them, and the comparison is public
([competitive-landscape.md](competitive-landscape.md)). Accepted: a reviewer who reads *what consumes
a file* is worth more than one who counts files.

**Reversal.** If the harness or a market plugin begins reading them, adopt the convention then — to
the schema that consumer expects, not the schema we guessed.

---

## ADR-009 — Settings are a registry in code, and a field's class is a property of its read sites

**Decision.** Every field the gate classifies is declared on `ctx.realtime.settings` with three fields of
its own: `kind` (how a text channel parses it and a control renders it), `scope` (live, session-bound or
restart-bound), and — for live fields only — the setter that applies a change. A key is
`<owner>.<field>`. `apply(key, text)` answers in the gate's own vocabulary: applied, or refused with a
machine code and a reason to relay.

**Why.** The gate's rule is that *an affordance the protocol cannot honour is worse than no affordance*,
and a classification that lives only in prose cannot refuse anything. Declaring the class also puts the
check where the mistake is made: a `live` field must declare a setter, a frozen one must not, and the
declared `kind` must match what `get()` actually returns — so a field that would render the wrong
control, or claim a change it cannot apply, fails at load rather than in a user's session.

**Consequence, and the reason this ADR is not just bookkeeping.** `autoStart` was classified live and is
not. Its only read site is the boot-time `if (config.autoStart) void open()`, so no change a running
process could make would be honoured — and a control for it would have done nothing while looking like it
did. The class of a field follows the code that reads it, not the table it was first written in, so the
gate moves the row and the registry refuses a `set` on it with the restart it needs. Two further
consequences of the same rule: a secret-bearing field reports no value at all (write-only, or the surface
breaches invariant 3 one layer out), and a change is journalled by key and not by value, because the
journal is the one record built to be read and pasted.

**Cost.** A field a plugin reads at boot must be declared frozen rather than merely treated as frozen —
and every future field costs a declaration. Accepted: the alternative is a control plane whose claims are
only as good as the reader's memory of which rows were true.

**Left undone, deliberately.** The four session-bound fields (`provider`, `model`, `voice`,
`instructions`) are not registered yet. Their class exists in the registry and is exercised by its tests,
but a value that takes effect at the next session open needs the pending-value behaviour the strip's story
specifies, and registering them without it would put a frozen control where a reconnect action belongs.

---

## ADR-010 — A hosted harness is demoted to a device driver, or it is not used

**Decision.** DSH is the only brain. A provider that also orchestrates — Deepgram Voice Agent owns
STT→LLM→TTS, speculative replies and function dispatch — is configured with `agent.think.endpoint`
pointed at DSH and **no `agent.think.functions` array at all**. GPT-Live-1 stays the default provider;
a second route ships beside it, never in front of it. (Chamber D-PS-001, D-PS-006.)

**Why.** ADR-001 rejected Responses delegation because it would put a second orchestrator beside DSH
and make DSH's permissions advisory rather than authoritative. That argument does not stop at the
protocol boundary — a hosted voice agent that owns its own LLM and its own function dispatch *is* the
same second orchestrator, wearing a vendor's name. Declaring DSH's tools to it would create a second
tool registry that drifts from the first, which is the failure ADR-008 names from the other side.

**Consequence, and the reason this is the load-bearing ADR.** `dsh-realtime-responder` has no
counterpart under such a provider: the app no longer authors the spoken turn, it *answers a completion*.
Under this decision the responder is replaced by a completions shim over
`SessionController['prompt']`, and DSH's real tools stay inside DSH's own loop where their schemas are
already the authority. The provider keeps one decision — *when* to speak — and loses the other —
*what* to say.

**Cost.** No speculative tool dispatch on the provider's side, so a long DSH tool loop is audible
silence; narration degrades to an injected canned line rather than a written one. DSH must expose an
OpenAI-compatible completions surface, which is a new integration door and a new thing to keep
credential-safe per ADR-005.

**Left undone, deliberately.** No function channel, and a conformance test asserts its absence — an
architecture document that forbids a thing and does not test the absence is a comment.

---

## ADR-011 — Capability is declared, and an unsupported call is refused by code

**Decision.** `RealtimeProviderInfo` gains `capabilities`: seven booleans
(`appendThinking`, `appAuthoredSpeech`, `injectLine`, `functionCalls`, `usageReporting`,
`transcriptDeltas`, `inputMute`). A call into a capability declared `false` throws a **new**
`REALTIME_ERROR_CODES.CAPABILITY_UNSUPPORTED`. No existing code is widened to mean it. (D-PS-003.)

**Amended 2026-10-17 — the seventh row, and a split rather than a relabel (issue #120).** The conformance
suite's first run found `appAuthoredSpeech` declared `false` on Deepgram while `appendCommentary` resolved: the
call succeeded and quietly provided the agent's wording instead of the application's, which is this ADR's own
failure mode wearing a passing test. The two tempting fixes were both wrong. Flipping the declaration to `true`
buys a green suite by relabelling a degradation. Widening the refusal without a replacement deletes narration.
So the capability split in two: `appAuthoredSpeech` keeps its strong promise and its refusal, and `injectLine`
carries the weaker one a provider that owns its own model can actually honour — *the agent says a line the
application chose, in its own words*. Narration moved to `injectLine`; the delegation answer stayed on
`appendCommentary`, where the application really is the author. The deciding precedent is `inputMute`'s: the
matrix describes the seam's method, and a method whose contract is unmet must refuse rather than resolve.

**Why.** ADR-008 says a file nothing reads is not a contract; the converse is the one that bites here —
an affordance the protocol cannot honour is worse than no affordance, because it fails *silently*.
Five seam capabilities have no equivalent on a hosted voice provider. Degrading them to no-ops passes
every coverage gate in the repo and is undetectable from outside it, which is precisely the false
positive the quality lens exists to reject: a suite that is green while the feature is absent.

**Consequence.** The seam does not split into a duplex interface and a cascade interface. One surface,
honest about its edges, beats two surfaces that each claim to be the real one — and the alternative
would have doubled every call site to buy a distinction the capability table already carries. A single
capability may still split when two genuinely different promises are hiding under one name, which is what
`injectLine` exists for; the test is whether a caller could be misled by the merger, not whether the names
differ. Under the cheap route, `appendThinking` remains declared missing (there is no silent channel to
degrade to), and spoken narration uses `injectLine` rather than being quietly dropped.

**Cost.** Every capability is declared, and every `false` owes a test asserting the refusal rather than
the absence. A new provider now costs a table, not just an adapter.

---

## ADR-012 — Instrument before the second provider

**Decision.** The journal (roadmap, *the next cycle*, step 3) and the per-stage metrics (chamber §6.3,
phase P2) come before the second adapter. A one-day wire probe comes before the adapter too: four
load-bearing assumptions — an update that replaces rather than appends, an injected line accepted
mid-turn, the absence of a usage event, utterance-level transcripts — are currently
documented-only, not observed. (D-PS-002, D-PS-005.)

**Why.** A second implementation added to a system with no sensing mechanism multiplies unknowns rather
than options: each unobservable swap adds a failure class nobody can attribute, debugging cost rises,
willingness to swap falls, and the seam ossifies back into the one implementation it already has. This
repo's own discipline draws the same line at a smaller scale — ✅ observed on the wire, ❓ documented —
and a specification built on ❓ is a guess with a citation attached.

**Consequence.** The cheap route arrives later than it could. The probe converts four ❓ into ✅ or ❌ in
a day, and a ❌ found in a probe costs an afternoon rather than a sprint.

**Cost.** Accepted, and stated plainly: this is a deliberate delay on the feature the work was asked
for, in exchange for being able to tell a working swap from a broken one.

---

## ADR-013 — Pipecat is deferred behind a transport requirement

**Decision.** No Python sidecar. Revisit only when SIP or WebRTC becomes a real requirement, not to
obtain a cheap cascade. (D-PS-004.)

**Why.** Transport and barge-in are device-driver concerns, and the provider already supplies both. A
sidecar is a shallow module: it relocates complexity into operations — two runtimes, two lifecycles,
two logs, both sides of one hand-off instrumented — without reducing any of it. It would also weaken
ADR-003, because a replay fixture cannot cover the Python half, so CI would assert less while looking
like it asserts more.

**Cost.** No WebRTC or telephony until it is asked for. If a phone-number product appears, this is the
ADR to reopen, and the reasoning inside it — *transport is a driver concern* — is what should be
re-examined first.

---

## ADR-014 — Gemini Live is the second duplex provider, and a composition is not a patch

**Decision.** `dsh-realtime-gemini` implements the seam's duplex half on Gemini's `BidiGenerateContent`
protocol, with `functionCalls: true` and the delegation answer carried by an in-band `toolResponse`. It
declares `appAuthoredSpeech: true` **because on this provider the application really is the author**: a
tool result is text the responder wrote, and the model is instructed to summarise it aloud. It declares
`appendThinking: false` and refuses it, and `injectLine: true` for narration. A delegation may now carry
a **structured `payload`** — OpenAI's client delegation sends metadata only, Gemini sends the task as
tool arguments, so `promptFrom` prefers `payload.task` and falls back to the transcript.

The repo ships **two bundle patches**: `cordis.gemini.patch.yml` (what `dsh.bundle.patch` names) and the
unchanged `cordis.patch.yml`. They are not merged, and the reason is not packaging taste.

**Why two patches.** Both compositions mount the same `dsh-realtime-agent` row, and that row's
`instructions` field is forwarded verbatim as the session's opening system instruction. The OpenAI
composition's brief says *you have no tools and no knowledge of this system* — correct there, because
that protocol delegates by convention and declares no function. The Gemini adapter declares
`ask_coding_agent` in its setup frame and ships a brief that names it. One shared row cannot hold both,
and a patch's `config` replaces the schema's defaults wholesale, so the wrong brief is not "merged" into
the right one — it simply wins. The failure that prevents is silent: the profile boots, the socket opens,
and the model is told it cannot call the function it was just given. So the brief lives in the adapter
that declares the tool, and each composition supplies its own route and model. The test that pins this
asserts the agent row has **no** `instructions` (`packages/realtime-gemini/tests/bundle-patch.spec.ts`).

**Consequence, measured while writing the composition test.** The patch's agent row must also name
`model: models/gemini-2.0-flash-exp`. The agent forwards its own `model` into
`RealtimeSessionOptions.model`, which every adapter prefers over its configured default; the agent
schema's default is `gpt-live-1`, so an omitted `model` would ask Gemini for `models/gpt-live-1` and fail
during the first session rather than at boot.

**Also settled here.** A cancelled tool call is not answered. When Gemini's own VAD interrupts the model,
the calls it had asked for arrive in `toolCallCancellation`; an answer for one of those ids is not a
result the model is waiting on, and a `toolResponse` for an id it has forgotten is a session error
dressed as an append. The session remembers withdrawn ids and drops answers for them — the delegation
still settles upstream, so `voice_diagnose` sees an answered turn while nothing was written back, which
is what "cancelled" means. Barge-in needs nothing else from this adapter: the provider stops its own
speech and the adapter never queues audio.

**A registry defect this work exposed.** Registering a provider route kept only `id`, `name` and
`description`, discarding `configured` and `capabilities`. Since `listProviders()` is the only surface
`voice_status` and `voice_diagnose` read, every route reported "does not say whether it is configured"
and `requireCapability` had nothing to read — the exact silent-undeclared failure ADR-011 exists to
prevent. The registry now keeps the whole declaration, and `packages/realtime/tests/registry.spec.ts`
pins it.

**Cost, stated because it is the honest part.** Every frame shape in this adapter is documented, not
observed: no run against Google's server has happened.

**Amended 2026-11-09, after re-reading the published reference.** Three shapes the first draft had are
wrong in ways a live socket would punish, and one model it named no longer exists:

- `models/gemini-2.0-flash-exp` is gone; the Live default is `gemini-3.8-live`. Extended Thinking is *not*
  advertised here because it requires asynchronous function calling (`behavior: NON_BLOCKING` plus
  `scheduling`), and this adapter answers with a blocking `toolResponse` — advertising it would promise a
  mode the delegation path does not implement.
- Audio is `realtimeInput.audio`; `mediaChunks[]` is deprecated and "all but the first will be ignored", so
  the old frame was an empty audio stream with no error.
- A `FunctionResponse` needs the call's `name` and carries `{ result }` directly, not an `output` wrapper.
  The session now remembers each call's name from its `toolCall`.
- Text on native-audio models is transcription, not `modelTurn` text: the setup enables
  `outputAudioTranscription` and `inputAudioTranscription`, and the session holds the newest output chunk
  until the next one or the turn's end, so the last chunk of a turn is the one marked `final` (hence
  `transcriptDeltas: true`). Chunk-vs-cumulative text is the one behaviour still unobserved; if it is
  cumulative the hold-and-release path will duplicate text, and that is the first thing a live run should
  falsify.

One operational fact from the same read: audio-only Live sessions are capped at 15 minutes, and session
resumption is not implemented. A long coding turn can be cut off, and the close surfaces as `onClosed`.

**Verified live, 2026-11-09.** One session through `scripts/gemini-probe.mjs` against `gemini-3.8-live`
confirmed the shapes above: setup accepted with the tool declaration and both transcription configs, a
`toolCall` carrying `id`, `name` and `args`, the named `toolResponse` accepted, 14 audio frames at 24 kHz, and
four `outputTranscription` events whose text concatenated cleanly — so output transcription is **chunked, not
cumulative**, which is what the hold-and-release path and `transcriptDeltas: true` assume.

A second run sent audio instead of text — the Live docs' sample clip — and the first attempt produced nothing
at all: the frames were delivered, but the server was still waiting for speech to continue. Ending the stream
with `realtimeInput.audioStreamEnd` flushed it, and the turn completed with `inputTranscription` *"Hey, can you
hear me?"* and the reply *"Yes, I can hear you clearly."* That is now the adapter's mute behaviour, because a
user switching the microphone off mid-sentence is the same situation.

Those runs also settled a number that had been a guess. `usageMetadata` reported 841 tokens for a turn whose
audio ran about two seconds; the `/50` proxy would have said seventeen. Usage is now **measured** from the
audio the session carried, divided by the declared sample rates. The frame still triggers the report; only
the number changed, because the seam's unit is audio seconds and a token count is not one.

What the run did **not** cover is enumerated in `docs/gemini-live-build.md` §5 — the 15-minute cap and
`goAway`, input transcription (the probe sent text), the browser-to-responder path, and entitlement refusals.
