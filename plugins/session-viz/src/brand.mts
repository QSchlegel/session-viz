// The one piece of chrome every page this plugin renders has to carry.
//
// There are four HTML wrappers here and until this file they looked like four
// products: /qpact (render.mts) opened with a title, a subtitle and a theme
// button; /qtrends (render-corpus.mts) with a title and a subtitle; qshare.mts
// with "Choose what to share"; qsetup.mts with "Connect this machine". Nothing
// on any of them said which tool had produced it, and no two of them agreed on
// what that tool looked like.
//
// ── Why this module carries its own paint ────────────────────────────────────
// The four pages do not share a stylesheet, and they should not start now: the
// only way to give the picker a logo out of render.mts would be to make it
// import several hundred lines of report CSS — a graph theme, a turn list, an
// alarm banner — for a 3x3 grid of squares. So everything here is
// self-contained. Every token it declares is prefixed `--sv-`, every rule it
// writes reads only those tokens, and `brandCss()` is a few hundred bytes a
// page appends to whatever <style> it already has.
//
// Nothing here reads --accent, --panel, --ink or --muted, even though three of
// the four pages define all four. Those names mean slightly different palettes
// on each page, and qsetup — which uses --card and --dim instead — defines
// neither --panel nor --muted at all. A logo that renders in the host page's
// variables is a logo that is invisible on the one page that spells them
// differently.
//
// Three theme states, like everywhere else in this project: tokens on bare
// `:root`, dark under the system query guarded against an explicit light
// choice, and dark again under `[data-theme=dark]` so /qpact's toggle wins in
// both directions. `color-scheme` is declared in each, so the browser's own
// chrome — scrollbars, form controls, the canvas behind a short page — follows
// the same three states rather than a fourth opinion.

import { version } from './version.mjs'

/** Exported because qsetup interpolates env-supplied values into a form that
 *  takes a token, and had no escaper of its own. */
export const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]!)

// ---------------------------------------------------------------- the mark

/**
 * Nine cells in a 3x3 grid: SEVEN settled, ONE accent, ONE hollow.
 *
 * The count is the entire reason this is a function rather than four template
 * literals. This project's own prose has said "eight settled cells" for months;
 * the sentence was copied into a brand kit, and nobody counted the rects. A
 * mark drawn once per page is a mark that will be wrong on at least one of
 * them, wrong in a way no compiler sees and no reviewer counts.
 *
 * The POSITIONS are not a design choice available here. This is the same mark
 * the site's nav draws, the brand kit ships and the launch film animates, and it
 * is only a logo if it is the same one in all of them: accent top-right, hollow
 * middle-right. The first version of this file put them bottom-centre and
 * bottom-right and wrote a rationale for that arrangement — the count was right,
 * every page agreed with every other page, and it was still a different logo
 * from the product's. Counting the cells is not the same as recognising the
 * mark, which is exactly why the check below pins where they are.
 *
 * Canonical source: services/web/public/index.html, the <g class="lg"> block —
 * `class="c a"` at index 2 and `class="c h"` at index 5, in reading order.
 */
const CELLS = 9
const ACCENT_AT = 2
const HOLLOW_AT = 5

/**
 * The grid's own measurements, from the kit rather than chosen here.
 *
 * Counting the cells and placing the accent correctly still left this drawing a
 * different logo from the product's, because the PROPORTIONS were its own: a
 * 6-unit cell on a 9-unit pitch is a gutter half the width of its cell, where
 * every other drawing of this mark -- the site nav, brand/svg/*.svg, the launch
 * film -- uses an 8-unit cell on a 10-unit pitch, a gutter one QUARTER of its
 * cell. Side by side at the same size the two read as different marks, and the
 * one on the reports was the odd one out.
 *
 * The box is 34 and the art starts at 2 because that is the clear space the kit
 * specifies -- one cell on all four sides, 23.5% of the mark's width -- and
 * brand/usage.md's minimum-size table is computed from a 1.6-unit stroke in a
 * 34-unit box. Reproducing those numbers is what makes the table true of this
 * drawing too.
 */
const BOX = 34
const CELL = 8
const PITCH = 10
const ORIGIN = 2
const RADIUS = 1.6
const STROKE = 1.6

/**
 * The smallest size at which this mark may be drawn, from brand/usage.md.
 *
 * Below it the hollow cell's outline falls under one device pixel, spreads
 * across two at partial opacity, and stops reading as an outline at all -- so
 * the mark says "nine cells" where it should say "one unresolved", which is the
 * only part of it carrying an argument. The header used to draw at 22 and the
 * footer at 15.
 */
export const MIN_MARK = 24

/**
 * The mark, as inline SVG.
 *
 * `aria-hidden`, because in both lockups below the wordmark sits immediately
 * beside it as real text. A screen reader that announces an `aria-label` on the
 * mark and then the wordmark says the product name twice.
 *
 * The viewBox is inset by one unit on each side rather than starting at 0: the
 * hollow cell is drawn with a stroke, half of which falls outside its own rect,
 * and an SVG clips to its viewport. Without the inset the bottom and right of
 * that one cell's outline are shaved off — which looks like a rendering bug in
 * exactly the cell whose whole job is to look deliberate.
 */
export function brandMark(size = MIN_MARK): string {
  const rects: string[] = []
  for (let i = 0; i < CELLS; i++) {
    const kind = i === HOLLOW_AT ? 'sv-hollow' : i === ACCENT_AT ? 'sv-accent' : 'sv-settled'
    rects.push(
      `<rect class="sv-cell ${kind}" x="${ORIGIN + (i % 3) * PITCH}" y="${ORIGIN + Math.floor(i / 3) * PITCH}" ` +
      `width="${CELL}" height="${CELL}" rx="${RADIUS}"/>`,
    )
  }
  // The box carries the kit's clear space, so the mark is never crowded by
  // whatever it is placed beside -- and the stroke on the hollow cell, half of
  // which falls outside its own rect, has room rather than being shaved off by
  // the viewport. A clipped outline looks like a rendering bug in exactly the
  // cell whose whole job is to look deliberate.
  return `<svg class="sv-mark" viewBox="0 0 ${BOX} ${BOX}" width="${size}" height="${size}" ` +
    `aria-hidden="true" focusable="false">${rects.join('')}</svg>`
}

/** SESSION·VIZ, with the separator carrying the accent. */
export function brandWordmark(): string {
  return `<span class="sv-word">SESSION<span class="sv-sep">·</span>VIZ</span>`
}

/** Mark and wordmark together. The only unit any page should place. */
export function brandLockup(size?: number): string {
  return `<span class="sv-lockup">${brandMark(size)}${brandWordmark()}</span>`
}

// ---------------------------------------------------------------- header

export interface HeaderOptions {
  /** The slash command that produced this page, shown as a chip. */
  command?: string
  /** Right-hand slot for the page's own controls — /qpact's theme button. */
  actions?: string
  /**
   * Quieter chrome, for qsetup.
   *
   * qsetup is a local auth page that takes a bearer token. A page asking for a
   * secret should look like less than it is, not more: no command chip, no
   * motion, no rule under the header. Anything that reads as a seal of office
   * on that page is teaching the reader to trust a layout, which is the exact
   * habit a phishing page needs them to have.
   */
  plain?: boolean
}

export function brandHeader(o: HeaderOptions = {}): string {
  const cls = o.plain ? 'sv-brand sv-plain' : 'sv-brand'
  const chip = o.command && !o.plain ? `<span class="sv-cmd">${esc(o.command)}</span>` : ''
  const acts = o.actions ? `<span class="sv-acts">${o.actions}</span>` : ''
  return `<header class="${cls}">${brandLockup()}${chip}${acts}</header>`
}

// ---------------------------------------------------------------- footer

/**
 * One provenance fragment.
 *
 * Plain text in, escaped here — the alternative is a footer that takes
 * pre-escaped HTML from four callers with four different `esc` helpers, one of
 * which does not escape `'`. `strong` exists because the fingerprint has always
 * been emphasised, and dropping that emphasis is dropping the one fragment
 * anyone actually copies.
 */
export interface Fact {
  /** Plain prefix, e.g. `fingerprint`. */
  label?: string
  value: string | number
  strong?: boolean
}

export interface FooterOptions {
  /**
   * The slash command that generated a report. When present the footer opens
   * with `generated by <command> · <timestamp>`, which is the sentence /qpact
   * and /qtrends have always opened with.
   *
   * Absent for the live loopback pages: a share picker is not generated at a
   * moment, it is served at one, and stamping a time on it would state a fact
   * about the page that the page cannot support.
   */
  command?: string
  /** Everything the page already printed. Falsy entries drop out. */
  facts: Array<Fact | string | null | undefined | false>
  /** Overridable so a test can render a byte-stable page. */
  at?: Date
  /** Matches `HeaderOptions.plain` — no rule above, no emphasis. */
  plain?: boolean
}

/**
 * The footer every page ends on.
 *
 * The provenance fragments are passed in rather than assembled here, and every
 * one of them survives verbatim. Those lines are why anyone believes a number
 * on these pages: how many records were read, which fingerprint the reading
 * has, that prompts were redacted before anything was written. A brand footer
 * that swallowed one of them to make room for a logo would have traded the
 * reason the page is trusted for the reason it is recognised.
 *
 * The version is the one thing added. Between 0.7.0 and 0.9.0 the same corpus
 * went from 27.31B cache-read to 31.94B — not because the corpus moved, but
 * because the reading got more correct. A report that does not say which build
 * produced it is a report nobody can reconcile with the one beside it.
 */
export function brandFooter(o: FooterOptions): string {
  const parts: string[] = []
  if (o.command) {
    const at = (o.at ?? new Date()).toISOString().slice(0, 16).replace('T', ' ')
    parts.push(`generated by ${esc(o.command)} · ${esc(at)}`)
  }
  for (const f of o.facts) {
    if (!f) continue
    const fact: Fact = typeof f === 'string' ? { value: f } : f
    const value = String(fact.value ?? '')
    if (!value) continue
    parts.push(
      (fact.label ? esc(fact.label) + ' ' : '') +
      (fact.strong && !o.plain ? `<b>${esc(value)}</b>` : esc(value)),
    )
  }
  const cls = o.plain ? 'sv-foot sv-plain' : 'sv-foot'
  return `<footer class="${cls}">${brandLockup()}` +
    `<span class="sv-ver">v${esc(version())}</span>` +
    `<span class="sv-prov">${parts.join(' · ')}</span></footer>`
}

// ---------------------------------------------------------------- css

/**
 * The brand's own stylesheet, for pages that share nothing else.
 *
 * Bracketed by comment sentinels so a test can lift exactly this region out of
 * a rendered page and check that no rule inside it names a colour — the tokens
 * below are the only place a literal is allowed to appear, and four pages of
 * report CSS around it make a document-wide grep useless for the question.
 *
 * Values are the family palette the reports already use, restated rather than
 * referenced. Borrowing --accent from a host page would have picked up qsetup's
 * #c25a2b on one page, render.mts's #c2521a on two others, and nothing at all
 * on a page that had not defined it yet.
 *
 * The accent is a shade deeper than the reports' #c2521a on purpose. It paints
 * the separator in SESSION·VIZ, which is a text glyph and owes 4.5:1 — and
 * #c2521a manages only 4.27:1 on qsetup's warmer #f7f5f0. One token that clears
 * AA on the warmest surface it lands on beats one that matches a sibling
 * exactly and fails on the one page nobody was looking at. The difference is
 * invisible beside the reports' own accent; the failure was not. test/brand.mjs
 * measures both sides off the rendered page, so this cannot quietly drift back.
 */
export function brandCss(): string {
  return `
/* sv-brand — one definition, every page. See src/brand.mts. */
:root{
  --sv-ink:#1c1b19; --sv-dim:#6b6862; --sv-line:#e6e2db;
  --sv-accent:#bb4e18; --sv-cell:#5f8a6d; --sv-hatch:#9a958c;
  --sv-sans:ui-sans-serif,-apple-system,"Segoe UI",Inter,sans-serif;
  --sv-mono:ui-monospace,SFMono-Regular,Menlo,monospace;
  color-scheme:light;
}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){
  --sv-ink:#ece9e4; --sv-dim:#9b968d; --sv-line:#302e37;
  --sv-accent:#ff8a4c; --sv-cell:#4c8a63; --sv-hatch:#6d6878;
  color-scheme:dark;
}}
:root[data-theme=dark]{
  --sv-ink:#ece9e4; --sv-dim:#9b968d; --sv-line:#302e37;
  --sv-accent:#ff8a4c; --sv-cell:#4c8a63; --sv-hatch:#6d6878;
  color-scheme:dark;
}
.sv-brand{display:flex;align-items:center;gap:12px;flex-wrap:wrap;
  margin:0 0 22px;padding:0 0 13px;border-bottom:1px solid var(--sv-line)}
/* No rule under the header on the auth page. A hairline is a letterhead, and a
   letterhead is the thing a token prompt must not have. */
.sv-brand.sv-plain{border-bottom:0;padding-bottom:0;margin-bottom:16px}
.sv-brand .sv-acts{margin-left:auto;display:inline-flex;gap:8px;align-items:center}
.sv-lockup{display:inline-flex;align-items:center;gap:9px}
.sv-mark{display:block;flex:none}
/* The settled cells are the kit's --cell-struct green, not a grey. This module
   restates the family palette rather than reading the host page's tokens, and
   the value it restated for the cells was one the brand does not contain. */
.sv-cell{fill:var(--sv-cell)}
.sv-cell.sv-accent{fill:var(--sv-accent)}
/* Outlined, not faded. A cell at 20% opacity reads as a settled cell the
   renderer got wrong; an outline reads as a cell that has not happened yet,
   which is what it is. */
/* --sv-hatch, not --sv-cell. The seven settled cells and the unresolved one are
   two different statements in this product's vocabulary and two different
   tokens everywhere else it draws them; painting the outline in the cell colour
   said the hole was a cell that had merely been drawn differently. */
.sv-cell.sv-hollow{fill:none;stroke:var(--sv-hatch);stroke-width:1.6}
/* THE WORDMARK. Sans, 600, .13em, uppercase, letters in --sv-ink and the middle
   dot in --sv-accent. Every other surface now matches this one; see
   brand/typography.md, which was rewritten to say so. */
.sv-word{font:600 13px/1 var(--sv-sans);letter-spacing:.13em;color:var(--sv-ink);white-space:nowrap}
.sv-sep{color:var(--sv-accent);letter-spacing:0;padding:0 .05em}
.sv-cmd{font:11px/1 var(--sv-mono);color:var(--sv-dim);border:1px solid var(--sv-line);
  border-radius:999px;padding:4px 9px;white-space:nowrap}
.sv-foot{display:flex;align-items:center;gap:10px;flex-wrap:wrap;
  margin:44px 0 0;padding:14px 0 0;border-top:1px solid var(--sv-line);
  color:var(--sv-dim);font:12px/1.6 var(--sv-mono)}
.sv-foot.sv-plain{margin-top:22px}
/* One wordmark, one setting. The footer used to run 11px at .11em and the
   header 13px at .13em, which is two specifications of the same logo. */
.sv-ver{font:11px/1 var(--sv-mono);color:var(--sv-dim);border:1px solid var(--sv-line);
  border-radius:999px;padding:3px 8px;white-space:nowrap}
/* min-width:0 or a long fingerprint refuses to wrap and pushes the flex row
   wider than the page, which on a file:// report is a horizontal scrollbar
   nobody can explain. */
.sv-prov{flex:1 1 260px;min-width:0}
.sv-prov b{color:var(--sv-ink);font-weight:600}
/* One shot, and only on the accent cell. The picker's frontier cell pulses
   because something is genuinely still running there; a mark that keeps
   pulsing tells the reader the page is still working long after it finished. */
@keyframes sv-land{from{opacity:0;transform:translateY(-2.5px)}to{opacity:1;transform:none}}
.sv-brand .sv-cell.sv-accent{animation:sv-land .45s ease-out 1 both}
.sv-brand.sv-plain .sv-cell.sv-accent{animation:none}
@media (prefers-reduced-motion:reduce){
  .sv-brand .sv-cell.sv-accent{animation:none}
}
/* end sv-brand */
`
}
