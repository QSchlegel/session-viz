// The picker page's own inline script, run against a stubbed streaming fetch.
//
// Two reasons this is not a copy of the script:
//
//   1. It lives inside a template literal. A stray backtick, or a `\n` escaped
//      once instead of twice, is a syntax error that kills the entire page —
//      which has happened twice, both times passing every markup check because
//      the markup was fine. Parsing the real page is the only way to see it.
//   2. The progress reader is stateful across chunk boundaries, and a stub that
//      delivers one tidy event per chunk would pass whether or not the
//      line-buffering exists. So the wire is cut into 7-byte pieces, which
//      splits nearly every event across at least one boundary.
//
// The DOM stub is deliberately unforgiving where the real DOM is: setting
// textContent clears children. An earlier version made it a plain property, and
// a bug that wiped the whole cell wall by writing textContent on the button
// passed the test written to catch it. A stub kinder than the browser tests
// nothing.

import vm from 'node:vm'
import { pickerPage } from '../scripts/qshare.mjs'

let pass = 0, fail = 0
const chk = (name, ok, got) => {
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (got ${JSON.stringify(got)})`}`)
  ok ? pass++ : fail++
}

const N = 5
const row = (i) => ({
  name: `proj${i}`, cwd: `/x/proj${i}`, ref: `proj${i}`, sessions: 3, turns: 9,
  textFields: i, bytes: 1000, harnesses: [['cursor', 3]], ambiguous: false,
})
const ROWS = Array.from({ length: N }, (_, i) => row(i))

/** One node, with the few DOM behaviours this script actually leans on. */
function el(tag, dataset = {}) {
  const node = {
    tagName: tag, disabled: false, checked: false, indeterminate: false,
    dataset, style: {}, _cls: new Set(), children: [], _row: null,
    classList: {
      add: (...c) => c.forEach((x) => node._cls.add(x)),
      remove: (...c) => c.forEach((x) => node._cls.delete(x)),
      contains: (c) => node._cls.has(c),
    },
    addEventListener: (ev, fn) => { node['_on' + ev] = fn },
    querySelectorAll: (sel) =>
      (sel.includes('rect.at') ? node.children.filter((c) => c._cls.has('at')) : node.children),
    closest: () => node._row,
  }
  let text = ''
  Object.defineProperty(node, 'textContent', {
    get: () => text,
    set: (v) => { text = String(v); node.children = [] },
  })
  let html = ''
  Object.defineProperty(node, 'innerHTML', {
    get: () => html,
    set: (v) => { html = String(v); node.children = [...v.matchAll(/<rect /g)].map(() => el('rect')) },
  })
  return node
}

/**
 * Run the page's script against a scripted event stream.
 * `events` is what the server sends; leaving off the `end` event models a
 * helper that died or a socket that dropped.
 */
function drive(events, { selected = N } = {}) {
  const wire = events.map((e) => JSON.stringify(e) + '\n').join('')
  const CHUNK = 7
  const chunks = []
  for (let i = 0; i < wire.length; i += CHUNK) chunks.push(wire.slice(i, i + CHUNK))

  const go = el('button'), lbl = el('span'), msg = el('div'), sum = el('span'), all = el('input')
  const boxes = ROWS.map((r, i) => {
    const b = el('input', { ref: r.ref, text: String(r.textFields) })
    b.checked = i < selected
    b._row = el('tr')
    return b
  })
  const byId = { go, lbl, msg, sum, all }
  const ctx = {
    console, TextDecoder, TextEncoder,
    document: {
      querySelectorAll: (sel) => (sel.includes('data-ref') ? boxes : []),
      getElementById: (id) => byId[id] ?? el('div'),
    },
    confirm: () => true,
    fetch: async () => ({
      ok: true,
      body: {
        getReader: () => {
          let i = 0
          return {
            read: async () => (i < chunks.length
              ? { value: new TextEncoder().encode(chunks[i++]), done: false }
              : { value: undefined, done: true }),
          }
        },
      },
    }),
  }
  ctx.window = ctx
  vm.createContext(ctx)

  const html = pickerPage(ROWS, 'test-nonce', new Set(['proj0']))
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]
  vm.runInContext(script, ctx)
  return { go, lbl, msg, boxes, chunks, run: () => go._onclick(), html }
}

const begun = (i) => ({ type: 'begin', i, name: `proj${i}` })
const landed = (i) => ({ type: 'done', i, name: `proj${i}`, id: `shr_${i}`, textFields: i, count: i + 1 })
const upTo = (n) => Array.from({ length: n }, (_, i) => [begun(i), landed(i)]).flat()

const filled = (go) => go.children.filter((c) => c._cls.has('on')).length
const pulsing = (go) => go.children.filter((c) => c._cls.has('at')).length

// ---- the page itself -------------------------------------------------------

console.log('\n── the page')
{
  const { html, chunks } = drive([{ type: 'start', total: N }, ...upTo(N), { type: 'end', shared: N, ids: [] }])
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]
  let ok = true
  try { new vm.Script(script) } catch (e) { ok = e.message }
  chk('the inline script parses', ok === true, ok)
  chk('every row is selectable', (html.match(/data-ref=/g) || []).length === N)
  chk('the shared one is badged', (html.match(/class="done"/g) || []).length === 1)
  const labels = (html.match(/for="c\d+"/g) || []).length
  const inputs = (html.match(/id="c\d+"/g) || []).length
  chk('no label points at a missing input', labels === inputs, `${labels}/${inputs}`)
  chk('the wire is genuinely split', chunks.length > N * 4, chunks.length)
}

// ---- everything lands ------------------------------------------------------

console.log('\n── all of it succeeds')
{
  const t = drive([{ type: 'start', total: N }, ...upTo(N), { type: 'end', shared: N, ids: [] }])
  await t.run()
  chk('one cell per selected project', t.go.children.length === N, t.go.children.length)
  chk('every cell ends filled', filled(t.go) === N, filled(t.go))
  chk('none left pulsing', pulsing(t.go) === 0, pulsing(t.go))
  chk('every row marked sent', t.boxes.filter((b) => b._row._cls.has('sent')).length === N)
  chk('reports the count', /Shared 5/.test(t.msg.textContent), t.msg.textContent)
  chk('ends on Done', t.lbl.textContent === 'Done', t.lbl.textContent)
  chk('button stays disabled', t.go.disabled === true)
}

// ---- it fails halfway ------------------------------------------------------

console.log('\n── it fails after two')
{
  const t = drive([{ type: 'start', total: N }, ...upTo(2), { type: 'error', error: 'token refused', shared: 2 }])
  await t.run()
  chk('the cell wall survives', t.go.children.length === N, t.go.children.length)
  chk('the two that landed stay filled', filled(t.go) === 2, filled(t.go))
  chk('none left pulsing', pulsing(t.go) === 0, pulsing(t.go))
  chk('only the sent rows are marked', t.boxes.filter((b) => b._row._cls.has('sent')).length === 2)
  chk('the error is shown', /token refused/.test(t.msg.textContent), t.msg.textContent)
  chk('says what already went out', /2 already went out/.test(t.msg.textContent), t.msg.textContent)
  chk('offers to send the rest', t.lbl.textContent === 'Share the rest', t.lbl.textContent)
  // The button rebuilds its list from what is ticked, so leaving the successes
  // ticked would publish them a second time — the opposite of what it offers.
  chk('sent boxes unticked, so a retry cannot double-publish',
    t.boxes.filter((b) => b.checked).length === N - 2, t.boxes.filter((b) => b.checked).length)
  chk('button re-enabled for the remainder', t.go.disabled === false)
}

// ---- the stream just stops -------------------------------------------------

console.log('\n── the helper dies mid-stream')
{
  // No `end`, no `error`: a closed tab, a killed process, a dropped socket. The
  // read completes cleanly, which is exactly why this has to be caught — the
  // obvious implementation calls it success and says everything went out.
  const t = drive([{ type: 'start', total: N }, ...upTo(3)])
  await t.run()
  chk('NOT reported as done', t.lbl.textContent !== 'Done', t.lbl.textContent)
  chk('NOT reported as shared', !/^Shared /.test(t.msg.textContent), t.msg.textContent)
  chk('says it stopped early', /stopped before it finished/.test(t.msg.textContent), t.msg.textContent)
  chk('the three that landed stay filled', filled(t.go) === 3, filled(t.go))
  chk('offers to send the rest', t.lbl.textContent === 'Share the rest', t.lbl.textContent)
}

console.log(`\n   ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
