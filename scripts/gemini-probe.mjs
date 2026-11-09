#!/usr/bin/env node
/**
 * The Gemini Live wire probe: the first thing to run with a real key.
 *
 * It answers the questions the offline suite cannot, in the order a wrong answer hurts:
 *
 *   1. Is a `setup` carrying `tools`, `systemInstruction` and both transcription configs accepted, and does
 *      `setupComplete` arrive on the same socket?
 *   2. Does a text turn produce a `toolCall` for `ask_coding_agent`, with an `id`, a `name` and `args`?
 *   3. Is a `toolResponse` carrying that `id` and `name` accepted, and does the model then finish a turn?
 *   4. Do transcripts arrive on `serverContent.outputTranscription` / `inputTranscription`, and is the output
 *      chunked (several events) or cumulative (the turn's text repeated)? That is the one unresolved question
 *      in `docs/gemini-live-build.md` §5, and this probe prints the events so the answer is visible.
 *   5. Does `usageMetadata` carry `totalTokenCount`?
 *
 * It executes **nothing**: the tool result is a canned string, so the channel is proven without running a
 * command. No audio is sent — a text turn reaches the delegation round trip, and costs far less than a spoken
 * one on a free-tier quota.
 *
 * Usage (the built package is needed; the gate builds it):
 *   pnpm build
 *   export GEMINI_API_KEY=…        # or GOOGLE_API_KEY
 *   node scripts/gemini-probe.mjs
 *
 * Exit codes: 0 = every check that must pass did; 1 = the wire said something else (printed); 2 = no key, or
 * the package is not built.
 */
import { existsSync } from 'node:fs'
import WebSocket from 'ws'

const BUILD = new URL('../packages/realtime-gemini/lib/index.js', import.meta.url)
if (!existsSync(BUILD)) {
  console.error('the package is not built: run `pnpm build` first (the probe imports the real wire builders)')
  process.exit(2)
}
const { buildSetupMessage, buildClientContentMessage, buildToolResponseMessage } = await import(BUILD.href)

const KEY = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY
if (KEY === undefined || KEY.trim().length === 0) {
  console.error('no Gemini credential in the environment. Create one at https://aistudio.google.com/api-keys')
  console.error('then, in the shell that runs this probe:  export GEMINI_API_KEY=…   (never commit it)')
  process.exit(2)
}

const MODEL = process.env.GEMINI_PROBE_MODEL ?? 'models/gemini-3.8-live'
const ENDPOINT = process.env.GEMINI_PROBE_ENDPOINT
  ?? 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent'
/** Canned on purpose: the probe tests the channel, not the workspace. */
const CANNED_RESULT = 'probe acknowledged the request; nothing was executed'
const BUDGET_MS = Number(process.env.GEMINI_PROBE_TIMEOUT_MS ?? 90_000)
const PROMPT = 'Please run `git status --short` in the workspace and tell me what it says.'

const seen = {
  setupComplete: false,
  toolCall: false,
  toolReplied: false,
  turnAfterReply: false,
  outputEvents: 0,
  outputText: '',
  inputTranscription: false,
  usage: false,
}
const notes = []

console.log(`endpoint  ${ENDPOINT}`)
console.log(`model     ${MODEL}`)
console.log('sending   setup (AUDIO modality, ask_coding_agent, both transcriptions)\n')

const socket = new WebSocket(`${ENDPOINT}?key=${encodeURIComponent(KEY.trim())}`)
let finished = false

const send = (message) => socket.send(JSON.stringify(message))

/** Print the observations, then exit. Called exactly once. */
function finish(why) {
  if (finished) return
  finished = true
  try { socket.close() } catch { /* already closing */ }

  const checks = {
    'setup accepted (setupComplete)': seen.setupComplete,
    'tool call raised for ask_coding_agent': seen.toolCall,
    'tool response accepted (a turn completed after it)': seen.turnAfterReply,
    'model transcript arrived (outputTranscription)': seen.outputEvents > 0,
  }
  console.log('\n— checks —')
  for (const [name, ok] of Object.entries(checks)) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`)
  console.log(`  ${seen.inputTranscription ? 'PASS' : 'info'}  user transcript arrived (inputTranscription)`)
  console.log(`  ${seen.usage ? 'PASS' : 'info'}  usage metadata arrived (usageMetadata)`)

  if (seen.outputEvents > 0) {
    // The §5 question, answered by counting events against text: equal text means cumulative, growing means
    // chunked (deltas), and the adapter holds the newest chunk either way.
    console.log(`\ntranscript events: ${seen.outputEvents}`)
    console.log(`transcript text:   ${JSON.stringify(seen.outputText)}`)
  }
  for (const note of notes) console.log(`  note: ${note}`)

  const passed = Object.values(checks).every(Boolean)
  console.log(`\n${passed ? 'PASS' : 'FAIL'} — ${why}`)
  process.exit(passed ? 0 : 1)
}

socket.on('open', () => {
  send(buildSetupMessage({
    model: MODEL,
    instructions:
      'You are a probe. When asked to do something in the workspace, call the ask_coding_agent tool. Keep every spoken reply to one short sentence.',
  }))
})

socket.on('message', (raw) => {
  let message
  try {
    message = JSON.parse(raw.toString('utf8'))
  } catch {
    notes.push('received a frame that was not JSON')
    return
  }

  if (message.setupComplete !== undefined) {
    seen.setupComplete = true
    console.log('<- setupComplete')
    send(buildClientContentMessage(PROMPT))
    return
  }

  if (message.error !== undefined) {
    notes.push(`provider error ${message.error.code ?? '?'}: ${message.error.message ?? '(no message)'}`)
    finish('the provider rejected the session or the response')
    return
  }

  if (message.goAway !== undefined) {
    notes.push(`goAway received: disconnect in ${message.goAway.timeLeft ?? 'an unstated time'}`)
  }

  const content = message.serverContent
  if (content !== undefined) {
    if (content.outputTranscription?.text !== undefined) {
      seen.outputEvents += 1
      seen.outputText += content.outputTranscription.text
      console.log(`<- outputTranscription: ${JSON.stringify(content.outputTranscription.text)}`)
    }
    if (content.inputTranscription?.text !== undefined) {
      seen.inputTranscription = true
      console.log(`<- inputTranscription: ${JSON.stringify(content.inputTranscription.text)}`)
    }
    if (content.interrupted === true) console.log('<- interrupted (barge-in)')
    for (const part of content.modelTurn?.parts ?? []) {
      if (part.inlineData !== undefined) {
        const bytes = Buffer.from(part.inlineData.data, 'base64').byteLength
        console.log(`<- audio frame: ${part.inlineData.mimeType}, ${bytes} bytes`)
      }
      if (part.text !== undefined) {
        notes.push(`modelTurn carried text (${JSON.stringify(part.text)}): the transcription-only assumption needs revisiting`)
      }
    }
    if (content.turnComplete === true) {
      console.log('<- turnComplete')
      if (seen.toolReplied) seen.turnAfterReply = true
      // One completed turn after the tool response is all this probe needs.
      if (seen.turnAfterReply) finish('setup, tool call, tool response and a transcript all observed')
      else if (!seen.toolCall) finish('the turn completed without ever calling the tool')
    }
  }

  if (message.toolCall?.functionCalls !== undefined) {
    seen.toolCall = true
    for (const call of message.toolCall.functionCalls) {
      console.log(`<- toolCall: id=${call.id} name=${call.name} args=${JSON.stringify(call.args ?? {})}`)
      if (typeof call.id !== 'string' || typeof call.name !== 'string') {
        notes.push('a function call arrived without an id or a name')
        continue
      }
      console.log(`-> toolResponse: id=${call.id} name=${call.name}`)
      send(buildToolResponseMessage(call.id, call.name, CANNED_RESULT))
      seen.toolReplied = true
    }
  }

  if (message.toolCallCancellation?.ids !== undefined) {
    notes.push(`toolCallCancellation for ${message.toolCallCancellation.ids.join(', ')}: the turn was interrupted`)
  }

  if (message.usageMetadata !== undefined) {
    seen.usage = true
    console.log(`<- usageMetadata: totalTokenCount=${message.usageMetadata.totalTokenCount ?? '(absent)'}`)
  }
})

socket.on('error', (error) => {
  notes.push(`socket error: ${error.message}`)
  finish('the socket failed')
})

socket.on('close', (code, reason) => {
  if (finished) return
  notes.push(`socket closed early (${code}${reason?.length > 0 ? `: ${reason.toString()}` : ''})`)
  finish('the socket closed before the round trip finished')
})

setTimeout(() => {
  notes.push(`no completion within ${BUDGET_MS} ms`)
  finish('the probe ran out of budget')
}, BUDGET_MS).unref()
