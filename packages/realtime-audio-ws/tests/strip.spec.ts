/**
 * The strip's rows: the plate's stylesheet, its container, and the bootstrap.
 *
 * Two things here cannot be checked any other way. The bootstrap is a *string* — an inline script the page
 * executes — and a string that nothing runs is a feature that nothing checks, which is the same defect class
 * as a build artefact no test reads. So it is executed here for real, through a function with a fake scope,
 * and every path it has is driven: a page whose bundle has not landed yet, and one that is still parsing its
 * body.
 *
 * And the stylesheet is a third file that has to agree with two others — the client's markup, which wears its
 * class names, and the *paint* the running app produces, which no DOM assertion can see. So the paint is
 * asserted against the layer that decides it, and the class names are read out of both files and compared.
 */

import { describe, expect, it } from 'vitest'
import {
  STRIP_ELEMENT_ID,
  STRIP_HEIGHT_PX,
  stripBootstrap,
  stripMarkup,
  stripRows,
  stripStyles,
} from '../src/strip.ts'
import { renderStrip } from '../src/client/index.ts'

/**
 * A fake page scope: the composer, and the client bundle's global.
 *
 * The bootstrap inserts one button beside the attachments button and toggles audio through the global the
 * client bundle publishes. Both are simulated here, because the shipped string is executed rather than
 * merely read: an inline script nothing runs is the defect class this file exists to catch.
 */
function page(over: { client?: unknown; anchor?: boolean } = {}) {
  const elements: Record<string, any> = {}
  const order: string[] = []
  const listeners: string[] = []
  const anchor = {
    insertAdjacentElement: (_where: string, element: any) => {
      elements[element.id] = element
      order.push(element.id)
      return element
    },
  }
  const client = over.client === undefined
    ? {
        mount: () => undefined,
        state: () => ({ kind: 'idle' }),
        start: () => { listeners.push('start'); return Promise.resolve() },
        stop: () => { listeners.push('stop') },
      }
    : over.client
  const document = {
    readyState: 'complete',
    documentElement: {},
    querySelector: (selector: string) =>
      over.anchor === false ? null : (selector.includes('Add files or run commands') ? anchor : null),
    getElementById: (id: string) => elements[id] ?? null,
    createElement: (_tag: string) => {
      const element: any = {
        id: '', className: '', title: '', type: '', innerHTML: '',
        dataset: {},
        attributes: {} as Record<string, string>,
        previousElementSibling: null,
        click: null as null | (() => void),
        setAttribute: (name: string, value: string) => { element.attributes[name] = value },
        addEventListener: (type: string, handler: () => void) => { if (type === 'click') element.click = handler },
        parentNode: { removeChild: () => { delete elements[element.id] } },
      }
      return element
    },
  }
  return { global: { __dshRealtimeAudio: client }, document, elements, order, toggles: listeners }
}

/** Run the shipped bootstrap as the page would: a function over the scope it reads. */
function run(script: string, target: ReturnType<typeof page>): void {
  // eslint-disable-next-line no-new-func -- executing our own shipped string is the point of this test.
  new Function('globalThis', 'document', script)(target.global, target.document)
}

/** The body of one rule, located by its selector. */
function rule(css: string, selector: string): string {
  const match = new RegExp(`(?:^|\\n)\\s*${selector.replaceAll('.', '\\.')}\\s*\\{([^}]*)\\}`, 'u').exec(css)
  if (match === null) throw new Error(`no rule for ${selector}`)
  return match[1]!
}

/**
 * The layers of a `background` value, split on the commas that are *not* inside a function.
 *
 * A gradient's own colours are comma-separated, so a naive split reads one layer as several and the guard
 * below ends up examining a colour instead of the layer that decides what shows through.
 * @param value - the `background` declaration's value.
 * @returns the layers, topmost first.
 */
function layers(value: string): string[] {
  const out: string[] = []
  let depth = 0
  let current = ''
  for (const character of value) {
    if (character === '(') depth += 1
    if (character === ')') depth -= 1
    if (character === ',' && depth === 0) {
      out.push(current.trim())
      current = ''
      continue
    }
    current += character
  }
  out.push(current.trim())
  return out
}

/** Every class name a piece of markup wears. */
function classesIn(markup: string): string[] {
  return [...markup.matchAll(/class="([^"]*)"/gu)].flatMap(match => match[1]!.split(/\s+/u)).filter(Boolean)
}

/** Every class name a stylesheet defines. */
function classesDefined(css: string): string[] {
  return [...css.matchAll(/\.(-?[_a-zA-Z][\w-]*)/gu)].map(match => match[1]!)
}

describe('stripRows', () => {
  it('contributes the stylesheet and the bootstrap, and no markup of its own', () => {
    // The surface is one icon inserted into the composer, so there is no element of ours on the page: no
    // container to style, no band to reserve, nothing that can overlap the conversation.
    expect(stripRows()).toEqual([
      { kind: 'style', text: stripStyles() },
      { kind: 'script', placement: 'body', text: stripBootstrap() },
    ])
  })

  it('is opaque, because the page it covers has its own text behind it', () => {
    // The defect this pins, reported from a screenshot of the running app: a wash let the host page's text
    // read *through* the panel, so two texts sat superimposed and neither was legible. Opacity is not
    // decoration here — it is the accessibility requirement — and no DOM test can see what is *behind* an
    // element, which is why this asserts the paint rather than a rendered pixel.
    //
    // The layer that decides it is the LAST one. The brushed top layer is deliberately translucent, and it
    // is only safe because there is a solid plate under it.
    const plate = layers(rule(stripStyles(), '#dsh-realtime-strip').match(/background:([^;]+);/u)![1]!)
    expect(plate.length).toBeGreaterThan(1)
    expect(plate.at(-1)).toMatch(/^linear-gradient\(180deg, #26282c/)
    expect(plate.at(-1)).not.toMatch(/transparent|rgb[a]?\([^)]*\/\s*0?\.\d/)
    // Above the page rather than blended into it.
    expect(rule(stripStyles(), '#dsh-realtime-strip')).toMatch(/box-shadow:/)
  })

  it('floats as a small chip and takes no band from the app', () => {
    // The plate used to be a full-width 1U bar that reserved the page's bottom band. It was too much
    // surface for a control that is idle most of the time, so it is now a chip in the corner: no
    // reservation to out-specify, and a compact deck.
    const styles = stripStyles()
    expect(styles).not.toContain('padding-bottom')
    const strip = rule(styles, '#dsh-realtime-strip')
    expect(strip).toContain('position: fixed')
    expect(strip).toContain('width: max-content')
    expect(strip).toContain('border-radius: 12px')
    expect(rule(styles, '.dvr-row')).toContain(`height: ${String(STRIP_HEIGHT_PX)}px`)
    expect(rule(styles, '.dvr-row .dvr-brand, .dvr-row .dvr-screw')).toContain('display: none')
  })

  it('carries an element the client can find, and no behaviour of its own', () => {
    const markup = stripMarkup()
    expect(markup).toContain(`id="${STRIP_ELEMENT_ID}"`)
    // Nothing executable in the markup, and nothing designed in it either: the panel is rendered by the
    // bundle and styled by this file's stylesheet, and a row that carried either would be logic or design no
    // test could reach.
    expect(markup).not.toContain('<script')
    expect(markup).not.toContain('onclick')
    expect(markup).not.toContain('style=')
  })

  it('never closes its own element early, and never opens one', () => {
    // The table's own contract: a row's text is spliced into the document's text, so a closing tag inside it
    // ends the element and everything after it becomes markup. A `<` anywhere in the stylesheet opens an
    // element just as surely, which is why it is banned rather than merely discouraged.
    expect(stripBootstrap()).not.toContain('</script')
    expect(stripMarkup()).not.toContain('</style')
    expect(stripStyles()).not.toContain('</style')
    expect(stripStyles()).not.toContain('<')
  })

  it('defines every class the panel wears, so the plate and its markup cannot drift apart', () => {
    // Two files, one design: this one writes the stylesheet and the client writes the markup that wears it.
    // Nothing in either is wrong on its own when a class stops matching — the panel simply renders unstyled,
    // which is the defect the screenshot showed in the first place.
    const defined = new Set(classesDefined(stripStyles()))
    const worn = new Set([
      ...classesIn(stripMarkup()),
      ...classesIn(renderStrip({
        reply: {
          ok: true,
          verb: 'status',
          voice: { open: true },
          settings: [
            { key: 'a.number', field: 'number', kind: 'number', scope: 'live', value: 1 },
            { key: 'a.boolean', field: 'boolean', kind: 'boolean', scope: 'live', value: true },
            { key: 'a.list', field: 'list', kind: 'string-list', scope: 'live', value: ['x'] },
            { key: 'a.secret', field: 'secret', kind: 'string-list', scope: 'live', value: undefined },
            { key: 'a.pick', field: 'sessionId', kind: 'string', scope: 'live', value: 'x', choices: ['x'] },
            { key: 'a.fixed', field: 'fixed', kind: 'string', scope: 'session', value: 'x' },
          ],
        },
        notes: { 'a.number': 'applied' },
        notice: 'something happened',
        noticeLink: 'https://example.invalid/',
        audio: { kind: 'failed', reason: 'no' },
        level: 'all',
        drafts: {},
        connecting: false,
      })),
    ])
    expect([...worn].filter(name => !defined.has(name))).toEqual([])
    // And the guard is not vacuous: it is reading a real set of names out of both files.
    expect(worn.size).toBeGreaterThan(20)
  })
})

describe('the bootstrap', () => {
  it('inserts one microphone icon beside the composer’s attachments button', () => {
    const target = page()
    run(stripBootstrap(), target)

    expect(target.order).toEqual(['dsh-realtime-mic'])
    const mic = target.elements['dsh-realtime-mic']
    expect(mic.className).toBe('dsh-rt-mic')
    expect(mic.attributes['aria-label']).toBe('Voice')
    expect(mic.attributes['data-live']).toBe('false')
  })

  it('toggles the audio through the client bundle, and repaints from its state', async () => {
    let kind = 'idle'
    const calls: string[] = []
    const target = page({
      client: {
        mount: () => undefined,
        state: () => ({ kind }),
        start: () => { calls.push('start'); kind = 'live'; return Promise.resolve() },
        stop: () => { calls.push('stop'); kind = 'idle' },
      },
    })
    run(stripBootstrap(), target)
    const mic = target.elements['dsh-realtime-mic']!

    mic.click()
    // The promise's completion repaints, so the icon does not wait for the next re-place.
    await Promise.resolve()
    expect(calls).toEqual(['start'])
    expect(mic.attributes['data-live']).toBe('true')
    expect(mic.attributes['aria-pressed']).toBe('true')

    mic.click()
    expect(calls).toEqual(['start', 'stop'])
  })

  it('does nothing when the composer is not on the page yet, and does not throw without a bundle', () => {
    const noAnchor = page({ anchor: false })
    expect(() => { run(stripBootstrap(), noAnchor) }).not.toThrow()
    expect(noAnchor.order).toEqual([])

    const noBundle = page({ client: undefined })
    expect(() => { run(stripBootstrap(), noBundle) }).not.toThrow()
    // It is placed anyway: only the repaint needs the bundle, and a control that appears a moment before the
    // engine does is better than one that never appears if the bundle lands first.
    expect(noBundle.order).toEqual(['dsh-realtime-mic'])
  })
})

