/**
 * The strip: the panel this plugin puts in the host's own page.
 *
 * S2 story 3. Until it existed the plugin was driven from a `globalThis` key in a devtools console, and the
 * roadmap's judgement on that was blunt — *a plugin driven from a console global will not be installed by
 * anyone*. What changes is not decoration: the on-switch moves into the page, and `sessionId`, which cost
 * two restarts and a false lead to change, becomes a picker.
 *
 * ## Where the behaviour lives, and why not here
 *
 * This module mints **rows** for `webserver/index-inject` — the door the page already receives its settings
 * through. Three of the host's six row kinds carry UI: `style` for the plate's stylesheet, `html` for raw
 * markup, `script` for an inline classic script. So the stylesheet, the markup and the bootstrap are here,
 * and **the panel's logic is not**: everything that decides what to render and what a button does lives in
 * the client bundle (`src/client/index.ts`), where it is covered by tests. A panel implemented inside an
 * injected string is a feature nothing can execute in CI, which is the same defect class as a build
 * artefact no test reads.
 *
 * The bootstrap is therefore three statements, and it is still *executed* by a test — as a function with a
 * fake scope — so the injected code is not exempt from the gate just because it is shipped as text.
 *
 * The one thing that crosses the boundary the other way is the **class names**: this file writes the
 * stylesheet and the client writes the markup that wears it, so the two can disagree without either being
 * wrong. A test reads both and refuses to let the client emit a class this stylesheet does not define.
 *
 * ## Docked, not floating
 *
 * The first version floated a rounded panel over the bottom right — the right ~40% × lower ~60% of the
 * window, on top of live chat text. That is what `docs/gui-faceplate.md` supersedes: a fixed overlay in a
 * page this plugin does not control will always overlap *something*, so the overlap is made the page's own
 * bottom band instead of the conversation. Two rules do it — the strip is a full-width 1U plate pinned to
 * the bottom, and the page's own body reserves that band with `padding-bottom`, so the app's layout sits
 * above it rather than under it. (`html body` rather than `body`: the host sets `html,body,#root{height:100%}`
 * and the app is `height:100%` inside it, so the extra specificity is what keeps the reservation winning
 * over the host's own `body` rule while the `box-sizing` keeps it inside 100% rather than making the page
 * scroll.)
 *
 * ## Two ways in, deliberately
 *
 * The bundle mounts the panel when it applies, and the injected script mounts it again in case it lands
 * first. Both are idempotent, because the order between the module table and the body rows is not something
 * this package controls, and a panel that appears only when two independent orderings agree is a panel that
 * appears only on the author's machine.
 *
 * @module dsh-realtime-audio-ws/strip
 */

import type { InjectedRow } from './injection.ts'

/** The element the panel mounts on. Duplicated in the client half, which cannot import it. */
export const STRIP_ELEMENT_ID = 'dsh-realtime-strip'

/** The compact deck's height, in pixels. The page reserves no band at all: the surface floats. */
export const STRIP_HEIGHT_PX = 34

/**
 * The panel's container, as markup.
 *
 * Nothing but an empty element with an id: the plate's appearance is the stylesheet below, and its contents
 * are minted by the client bundle. Carrying either here would put the panel's design inside a string that
 * nothing executes.
 * @returns one `html` row's payload.
 */
export function stripMarkup(): string {
  return `<div id="${STRIP_ELEMENT_ID}"></div>`
}

/**
 * The plate's stylesheet.
 *
 * Authored rather than inherited, which **reverses a documented decision**: this module used to say the
 * panel inherits the host's font and colour *"rather than inventing a second visual language beside it."*
 * A faceplate **is** a second visual language, and that is the point of it — a piece of studio hardware
 * looks the same in light and dark mode, so an authored surface stops chasing a host theme it cannot see.
 * The reversal is recorded here so it cannot later be read as an accident, and the *rationale* for the
 * original decision is kept where it still applies: the base layer is **opaque**, so the opacity that was
 * once a caveat is now a property of the material.
 *
 * Three constraints are load-bearing rather than stylistic:
 *
 * - **No `<` anywhere** — the row is spliced into the document's text, and a `<` would open an element.
 * - **No closing `style` tag**, for the same reason.
 * - **The last `background` layer is opaque.** A translucent wash lets the host page's own text read
 *   straight through the panel: two texts superimposed, neither legible. That was reported from a
 *   screenshot of the running app, which is the only way it was ever going to be found — no DOM assertion
 *   can see what is *behind* an element. The brushed top layer is deliberately translucent; the plate
 *   beneath it is not, and a test reads the last layer specifically.
 * @returns one `style` row's payload.
 */
export function stripStyles(): string {
  return `
/* The one control: a microphone icon in the composer's own toolbar, beside the attachments button. It is
   deliberately unstyled compared with its neighbours — transparent until hovered — so it reads as part of
   the composer rather than as a surface the plugin added. */
.dsh-rt-mic {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  opacity: .72;
}
.dsh-rt-mic:hover { opacity: 1; background: rgb(127 127 127 / 14%); }
.dsh-rt-mic svg { width: 17px; height: 17px; }
.dsh-rt-mic[data-live="true"] { opacity: 1; color: #e0574a; }
.dsh-rt-mic[data-live="true"] svg { filter: drop-shadow(0 0 3px rgb(224 87 74 / 55%)); }

/* Five bars, not a microphone: the icon is the conversation's liveness, not an input device. They sit still
   when the session is closed and breathe while it is live — the only animated thing in the composer, and
   only when the microphone is actually open. */
.dsh-rt-bar { transform-box: fill-box; transform-origin: center; }
.dsh-rt-mic[data-live="true"] .dsh-rt-bar { animation: dsh-rt-bars 900ms ease-in-out infinite alternate; }
.dsh-rt-mic[data-live="true"] .dsh-rt-bar:nth-child(2) { animation-delay: 110ms; }
.dsh-rt-mic[data-live="true"] .dsh-rt-bar:nth-child(3) { animation-delay: 220ms; }
.dsh-rt-mic[data-live="true"] .dsh-rt-bar:nth-child(4) { animation-delay: 330ms; }
.dsh-rt-mic[data-live="true"] .dsh-rt-bar:nth-child(5) { animation-delay: 440ms; }
@keyframes dsh-rt-bars { from { transform: scaleY(.4); } to { transform: scaleY(1); } }

/* The plate below is the old faceplate's material. It is no longer mounted in the app — the chip's music
   did not survive the owner's judgement that any surface of its own is too much — but the layout gate and
   the colour test still read it, and the panel package may mount it again. */
#dsh-realtime-strip {
#dsh-realtime-strip {
  /* A chip in the corner, not a band across the page: small enough to ignore, and floating so the app's
     own layout gives up nothing. When a drill level opens it grows upward from this anchor. */
  position: fixed;
  right: 14px;
  bottom: 14px;
  z-index: 2147483000;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  width: max-content;
  max-width: min(92vw, 460px);
  border: 1px solid #3a3d42;
  border-radius: 12px;
  overflow: hidden;
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 11px;
  line-height: 1.35;
  color: #e9e2ce;
  background:
    repeating-linear-gradient(90deg, rgb(255 255 255 / 1.5%) 0 1px, rgb(20 22 25 / 0%) 1px 3px),
    linear-gradient(180deg, #26282c 0%, #1b1d20 42%, #141619 100%);
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 6%), 0 10px 28px rgb(0 0 0 / 45%);
  -webkit-user-select: none;
  user-select: none;
}

#dsh-realtime-strip * { box-sizing: border-box; }

.dvr-row {
  display: flex;
  align-items: center;
  gap: 10px;
  height: ${String(STRIP_HEIGHT_PX)}px;
  padding: 0 10px;
}

/* The deck's identity, not its controls: a chip in the corner should read as a control, not as hardware. */
.dvr-row .dvr-brand, .dvr-row .dvr-screw { display: none; }

.dvr-screw {
  flex: 0 0 auto;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: radial-gradient(circle at 35% 30%, #6b6f76, #2a2d31 70%);
  box-shadow: inset 0 1px 1px rgb(255 255 255 / 25%), 0 1px 1px rgb(0 0 0 / 60%);
}

.dvr-brand { display: flex; flex-direction: column; line-height: 1.15; }
.dvr-name {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: .34em;
  color: #efe7d2;
  text-shadow: 0 1px 0 #000, 0 -1px 0 rgb(255 255 255 / 9%);
}
.dvr-model { font-size: 8.5px; font-style: normal; letter-spacing: .2em; color: #9a8f75; margin-top: 2px; }

.dvr-rule {
  flex: 0 0 auto;
  width: 1px;
  height: 30px;
  opacity: .55;
  background: linear-gradient(180deg, rgb(201 162 39 / 0%), #c9a227 20%, #c9a227 80%, rgb(201 162 39 / 0%));
}

.dvr-jewel { display: flex; align-items: center; gap: 8px; }
.dvr-lamp {
  width: 13px;
  height: 13px;
  border-radius: 50%;
  background: radial-gradient(circle at 38% 32%, #6a6f76, #33383d 60%);
  box-shadow: inset 0 0 3px rgb(0 0 0 / 80%);
}
.dvr-jewel[data-lamp="live"] .dvr-lamp {
  background: radial-gradient(circle at 38% 32%, #d8ffe2, #33d06a 45%, #106b34 100%);
  box-shadow: 0 0 10px rgb(51 208 106 / 65%), inset 0 0 3px rgb(255 255 255 / 70%);
}
.dvr-jewel[data-lamp="connecting"] .dvr-lamp {
  background: radial-gradient(circle at 38% 32%, #ffeec4, #e8a72a 45%, #7a5407 100%);
  box-shadow: 0 0 10px rgb(232 167 42 / 60%), inset 0 0 3px rgb(255 255 255 / 70%);
}
.dvr-jewel-label { font-size: 8.5px; font-style: normal; letter-spacing: .16em; color: #9a8f75; }

.dvr-meter { flex: 1 1 120px; max-width: 220px; }
.dvr-scale {
  display: flex;
  height: 8px;
  gap: 1px;
  padding: 1px;
  border-radius: 2px;
  background: #0d0f11;
  box-shadow: inset 0 1px 2px rgb(0 0 0 / 90%), inset 0 -1px 0 rgb(255 255 255 / 4%);
}
.dvr-seg { flex: 1; border-radius: 1px; background: #23262a; }
.dvr-seg.on { background: linear-gradient(180deg, #7de29b, #2f9c56); }
.dvr-seg.on.warm { background: linear-gradient(180deg, #ffd98a, #d99b18); }
.dvr-seg.on.hot { background: linear-gradient(180deg, #ff9b8a, #cf3a26); }
.dvr-cap {
  display: flex;
  justify-content: space-between;
  font-size: 8px;
  letter-spacing: .14em;
  color: #8a8270;
  margin-bottom: 3px;
}

.dvr-where {
  font-size: 9px;
  letter-spacing: .14em;
  color: #9a8f75;
  padding: 2px 7px;
  border-radius: 3px;
  white-space: nowrap;
  background: linear-gradient(180deg, #101214, #17191c);
  box-shadow: inset 0 1px 0 rgb(0 0 0 / 90%), 0 1px 0 rgb(255 255 255 / 5%);
}

.dvr-spacer { flex: 1 1 auto; }

.dvr-btn {
  flex: 0 0 auto;
  cursor: pointer;
  font-family: inherit;
  font-size: 10px;
  letter-spacing: .18em;
  color: #efe7d2;
  background: linear-gradient(180deg, #33373c, #212427);
  border: 1px solid #45484e;
  border-radius: 4px;
  padding: 7px 11px;
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 10%), 0 1px 2px rgb(0 0 0 / 50%);
}
.dvr-btn.on {
  color: #f4ffe8;
  border-color: #3f7f52;
  background: linear-gradient(180deg, #2f5f3d, #1c4026);
}
.dvr-btn:active { background: linear-gradient(180deg, #212427, #33373c); }

.dvr-fault, .dvr-notice {
  margin: 0;
  padding: 5px 14px 6px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 11px;
  border-top: 1px solid #2c2f34;
}
.dvr-fault { color: #ff9b8a; }
.dvr-notice { color: #efe7d2; }
.dvr-notice a { color: #e8a72a; }

/* One level of drill-through: the panel grows upward from the plate. */
.dvr-panel {
  max-height: 46vh;
  overflow: auto;
  padding: 12px 14px 14px;
  border-top: 1px solid #2c2f34;
}
/* The dials wrap: a knob unit is 96px minimum and the gaps are 30px, so three of them need 348px — more
   than a narrow pane gives. Without wrapping the last unit (label, value and its Set button) prints past
   the plate's border: measured at a 327px plate as MILESTONES +52px, its value +52px and Set +76px, and
   at 427px as Set +3px. Found by the fixture gate, not by eye — the knobs only exist when settings do. */
.dvr-knobs { display: flex; gap: 30px; row-gap: 14px; align-items: flex-start; flex-wrap: wrap; }
.dvr-knob-unit { text-align: center; min-width: 96px; flex-shrink: 0; }
.dvr-knob {
  /* Block, not inline: a span's width and height are ignored, so the dial would paint as a line box and
     only its pointer would be visible. */
  display: block;
  position: relative;
  width: 46px;
  height: 46px;
  margin: 0 auto 7px;
  border-radius: 50%;
  background:
    conic-gradient(from 0deg, #2b2e33, #3a3e44 12%, #2b2e33 25%, #3a3e44 37%, #2b2e33 50%,
      #3a3e44 62%, #2b2e33 75%, #3a3e44 87%, #2b2e33),
    radial-gradient(circle at 40% 34%, #43474d, #1c1f22 72%);
  box-shadow: 0 3px 7px rgb(0 0 0 / 65%), inset 0 1px 1px rgb(255 255 255 / 14%);
}
.dvr-knob::after {
  content: "";
  position: absolute;
  left: 50%;
  top: 4px;
  width: 2px;
  height: 15px;
  margin-left: -1px;
  border-radius: 1px;
  background: linear-gradient(180deg, #f2e9d2, #b9ad8c);
  box-shadow: 0 0 3px rgb(0 0 0 / 80%);
  transform-origin: 50% 19px;
}
.dvr-knob--0::after { transform: rotate(-135deg); }
.dvr-knob--1::after { transform: rotate(-108deg); }
.dvr-knob--2::after { transform: rotate(-81deg); }
.dvr-knob--3::after { transform: rotate(-54deg); }
.dvr-knob--4::after { transform: rotate(-27deg); }
.dvr-knob--5::after { transform: rotate(0deg); }
.dvr-knob--6::after { transform: rotate(27deg); }
.dvr-knob--7::after { transform: rotate(54deg); }
.dvr-knob--8::after { transform: rotate(81deg); }
.dvr-knob--9::after { transform: rotate(108deg); }
.dvr-knob--10::after { transform: rotate(135deg); }
.dvr-knob-label { display: block; font-size: 8.5px; letter-spacing: .15em; color: #9a8f75; }
.dvr-knob-value { display: block; font-size: 10px; color: #e9e2ce; margin-top: 2px; }
.dvr-knob-caption { display: block; font-size: 8.5px; color: #c9a227; margin-top: 3px; }
.dvr-knob-set { display: flex; gap: 6px; justify-content: center; margin-top: 6px; }

.dvr-switches { display: flex; gap: 22px; align-items: center; margin-top: 18px; }
.dvr-led {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
  background: #0f1113;
  box-shadow: inset 0 0 2px rgb(0 0 0 / 90%);
}
.dvr-led.on {
  background: radial-gradient(circle at 40% 35%, #fff6d5, #e8a72a 55%, #8a5f08 100%);
  box-shadow: 0 0 7px rgb(232 167 42 / 75%);
}
.dvr-led.on.green {
  background: radial-gradient(circle at 40% 35%, #dcffe6, #33d06a 55%, #0f6b34 100%);
  box-shadow: 0 0 7px rgb(51 208 106 / 70%);
}
.dvr-switch {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  font-family: inherit;
  font-size: 8.5px;
  letter-spacing: .14em;
  color: #9a8f75;
  background: none;
  border: 0;
  padding: 0;
}
.dvr-switch-state { color: #e9e2ce; font-weight: 400; letter-spacing: .1em; }

.dvr-tabs { display: flex; gap: 8px; margin-top: 16px; border-top: 1px dashed #33363b; padding-top: 12px; }
.dvr-tab {
  cursor: pointer;
  font-family: inherit;
  font-size: 9px;
  letter-spacing: .16em;
  color: #8a8270;
  padding: 5px 9px;
  border: 0;
  border-radius: 3px;
  background: none;
}
.dvr-tab.active { color: #efe7d2; background: #1c1f22; box-shadow: inset 0 1px 0 rgb(255 255 255 / 7%); }

.dvr-srow {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  padding: 6px 0;
  font-size: 10px;
  border-bottom: 1px solid #1e2124;
}
.dvr-skey { color: #9a8f75; letter-spacing: .1em; min-width: 210px; }
.dvr-sdesc { color: #6f7885; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
.dvr-note { font-style: normal; color: #c9a227; }
.dvr-fixed { font-style: normal; color: #8a8270; }
.dvr-write-only { font-style: normal; color: #c9a227; width: 100%; }
.dvr-empty { color: #6f7885; padding: 6px 0; }

.dvr-input, .dvr-select {
  font-family: inherit;
  font-size: 10px;
  color: #e9e2ce;
  background: linear-gradient(180deg, #101214, #17191c);
  border: 1px solid #3a3d42;
  border-radius: 3px;
  padding: 4px 6px;
}
.dvr-input { min-width: 90px; }
.dvr-input--wide { min-width: 200px; }

.dvr-list { list-style: none; margin: 0; padding: 0; width: 100%; }
.dvr-entry { display: flex; align-items: center; gap: 8px; padding: 2px 0; }
.dvr-entry-value { color: #e9e2ce; }
.dvr-remove {
  cursor: pointer;
  font-family: inherit;
  font-size: 10px;
  color: #ff9b8a;
  background: none;
  border: 1px solid #4a3a38;
  border-radius: 3px;
  padding: 1px 5px;
}
`
}

/**
 * The bootstrap the page runs after the markup.
 *
 * It calls the bundle's own `mount`, and does nothing when the bundle has not been materialised yet — in
 * which case the bundle mounts the panel itself when it applies, or this is called again on
 * `DOMContentLoaded`. Nothing here decides anything about the panel; it is a doorbell.
 * @returns one `script` row's payload.
 */
export function stripBootstrap(): string {
  // One icon, inserted beside the composer's attachments button. It is a classic script with no imports,
  // because it is shipped as an `index-inject` row; the audio engine is the client bundle's, reached through
  // the global that bundle publishes.
  return [
    ';(function () {',
    "  var ID = 'dsh-realtime-mic'",
    "  function api() { return globalThis.__dshRealtimeAudio }",
    "  function live() { var a = api(); if (!a || typeof a.state !== 'function') return false; var s = a.state(); return !!s && s.kind === 'live' }",
    "  function paint(b) {",
    "    if (!b) return",
    "    var a = api(); var s = a && typeof a.state === 'function' ? a.state() : undefined",
    "    var on = !!s && s.kind === 'live'",
    "    b.setAttribute('data-live', on ? 'true' : 'false'); b.setAttribute('aria-pressed', on ? 'true' : 'false')",
    "    b.title = a === undefined ? 'Voice: client not loaded' : (s && s.kind === 'failed' ? 'Voice: ' + s.reason : 'Voice')",
    "  }",
    "  function toggle() {",
    "    var a = api()",
    "    if (!a) { paint(document.getElementById(ID)); return }",
    "    var done = function () { paint(document.getElementById(ID)) }",
    "    try { var p = live() ? a.stop() : a.start(); if (p && typeof p.then === 'function') p.then(done, done); else done() } catch (e) { done() }",
    "  }",
    "  function icon() {",
    "    var b = document.createElement('button')",
    "    b.id = ID; b.type = 'button'; b.className = 'dsh-rt-mic'; b.title = 'Voice'; b.setAttribute('aria-label', 'Voice')",
    "    b.innerHTML = \"<svg viewBox='0 0 24 24' fill='currentColor' aria-hidden='true'><rect class='dsh-rt-bar' x='3' y='10' width='2.4' height='4' rx='1.2'></rect><rect class='dsh-rt-bar' x='7.5' y='7' width='2.4' height='10' rx='1.2'></rect><rect class='dsh-rt-bar' x='12' y='4' width='2.4' height='16' rx='1.2'></rect><rect class='dsh-rt-bar' x='16.5' y='8' width='2.4' height='8' rx='1.2'></rect><rect class='dsh-rt-bar' x='21' y='10.5' width='2' height='3' rx='1'></rect></svg>\"",
    "    b.addEventListener('click', toggle)",
    "    return b",
    "  }",
    "  function place() {",
    "    var anchor = document.querySelector(\"button[aria-label='Add files or run commands']\")",
    "    if (!anchor) return",
    "    var existing = document.getElementById(ID)",
    "    if (existing) {",
    "      if (existing.previousElementSibling === anchor) { paint(existing); return }",
    "      existing.parentNode.removeChild(existing)",
    "    }",
    "    var b = icon()",
    "    anchor.insertAdjacentElement('afterend', b)",
    "    paint(b)",
    "  }",
    "  place()",
    "  if (typeof MutationObserver !== 'undefined') { try { new MutationObserver(place).observe(document.documentElement, { childList: true, subtree: true }) } catch (e) {} }",
    '})()',
  ].join('\n')
}

/**
 * The three rows this plugin contributes for its panel.
 *
 * The stylesheet first, because it is a `head` row (the host fixes a `style` row's placement) and the
 * markup is a `body` row — the two land in different groups, so table order among them is what it looks
 * like and nothing depends on it. The markup precedes the bootstrap within `body`, and that ordering the
 * table does guarantee: the panel's element exists before the script that mounts on it runs.
 *
 * Neither payload may contain a closing script or style tag — the table's own contract, because the row is
 * spliced into the document text — and a test asserts that for both, alongside executing the bootstrap.
 * @returns the rows, in the order they must execute.
 */
export function stripRows(): InjectedRow[] {
  // No markup row: the surface is one icon the bootstrap inserts into the composer, so there is no element
  // of ours on the page to style, reserve space for, or overlap anything with.
  return [
    { kind: 'style', text: stripStyles() },
    { kind: 'script', placement: 'body', text: stripBootstrap() },
  ]
}
