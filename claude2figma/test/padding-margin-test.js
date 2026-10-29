// Padding & margin copying test (needs jsdom: run `npm install` once at the repo root)
// Two halves of the same promise:
//   A) CAPTURE  — a flex card with CSS padding AND child CSS margins must come
//      out of the serializer with layout.padding set AND a gap that reproduces
//      the margins (CSS `gap: 0` + uniform child margins is a common pattern
//      like `* + * { margin-top: 1rem }` — margins must not be lost).
//      A plain block card with padding must keep both via stack inference.
//   B) IMPORT   — the same layout must land on the real Figma frame as
//      paddingTop/…/itemSpacing through the plugin builder.
//   node test/padding-margin-test.js
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const INJECT = fs.readFileSync(path.join(__dirname, '..', 'extension', 'inject.js'), 'utf8');
const CODE = fs.readFileSync(path.join(__dirname, '..', 'figma-plugin', 'code.js'), 'utf8');

function deepFind(node, pred) {
  if (!node || typeof node !== 'object') return null;
  if (pred(node)) return node;
  for (const key of ['children', 'root']) {
    const kids = node[key];
    if (Array.isArray(kids)) {
      for (const k of kids) {
        const found = deepFind(k, pred);
        if (found) return found;
      }
    }
  }
  return null;
}

// ------------------------------------------------------------- A: capture
async function captureTest() {
  let JSDOM;
  for (const candidate of ['jsdom', '/tmp/dbtest/node_modules/jsdom']) {
    try { ({ JSDOM } = require(candidate)); break; } catch (_) { /* next */ }
  }
  if (!JSDOM) {
    console.log('⏭️ padding-margin-test A (capture) skipped (jsdom not installed — run: npm install)');
    return;
  }

  const dom = new JSDOM(
    '<!doctype html><html><head><title>Pad Test</title></head><body></body></html>',
    { url: 'https://example.claudeusercontent.com/canvas', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;

  // jsdom has no layout engine: rects come from data-rect attributes.
  function rectOf(el) {
    const raw = (el.getAttribute && el.getAttribute('data-rect')) || '0,0,10,10';
    const [x, y, w, h] = raw.split(',').map(Number);
    return { x, y, width: w, height: h, top: y, left: x, right: x + w, bottom: y + h, toJSON() { return this; } };
  }
  window.Element.prototype.getBoundingClientRect = function () { return rectOf(this); };
  Object.defineProperty(window.HTMLElement.prototype, 'offsetWidth', {
    configurable: true, get() { return rectOf(this).width; },
  });
  // Text nodes measure themselves from a Range over their contents — point
  // the stub at the containing element's rect so element positions (and the
  // gaps/margins between them) survive into captured TEXT rects, the way a
  // real browser's range rects would.
  function rangeRect() {
    const el = this.commonAncestorContainer || this.startContainer;
    const host = el && el.nodeType === 1 ? el : el && el.parentElement;
    if (host && typeof host.getBoundingClientRect === 'function') return host.getBoundingClientRect();
    return rectOf(this);
  }
  window.Range.prototype.getBoundingClientRect = function () { return rangeRect.call(this); };
  window.Range.prototype.getClientRects = function () { return [rangeRect.call(this)]; };

  let captured = null;
  window.chrome = { runtime: { sendMessage(msg) { if (msg && msg.type === 'capture-result') captured = msg.payload; } } };

  // Flex card: padding 24, CSS gap 0, three children each with margin-bottom 16.
  // Geometry (data-rect): card 400×276; kids at y 24/100/176 (16px apart, last
  // ends at 236, leaving 40 = 24 padding + 16 trailing margin).
  // Block card: padding 24, two kids 16 apart (control case — stack inference).
  window.document.body.innerHTML =
    '<div class="flexcard" data-rect="0,0,400,276" style="display:flex; flex-direction:column;'
    + ' padding-top:24px; padding-right:24px; padding-bottom:24px; padding-left:24px; gap:0px">'
    + '<div data-rect="24,24,352,60" style="margin-bottom:16px">A</div>'
    + '<div data-rect="24,100,352,60" style="margin-bottom:16px">B</div>'
    + '<div data-rect="24,176,352,60" style="margin-bottom:16px">C</div>'
    + '</div>'
    + '<div class="blockcard" data-rect="500,0,400,184" style="background:#fff;'
    + ' padding-top:24px; padding-right:24px; padding-bottom:24px; padding-left:24px">'
    + '<div data-rect="524,24,352,60">A</div>'
    + '<div data-rect="524,100,352,60">B</div>'
    + '</div>';

  window.eval(INJECT);
  for (let i = 0; i < 50 && !captured; i += 1) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert(captured, 'serializer should send a capture-result');
  assert.strictEqual(captured.ok, true, `capture should succeed: ${captured.error || ''}`);
  const payload = JSON.parse(captured.json);

  const flex = deepFind(payload.root, (n) => /flexcard/.test(n.name || ''));
  assert(flex, 'flex card present in payload');
  assert(flex.layout, 'flex card has layout data');
  assert(['HORIZONTAL', 'VERTICAL'].includes(flex.layout.mode),
    `flex card keeps auto-layout mode, got ${flex.layout.mode}`);
  assert.strictEqual(flex.layout.mode, 'VERTICAL', 'column flex stays VERTICAL');
  assert.strictEqual(flex.layout.padding.top, 24, 'flex padding-top copies from CSS');
  assert.strictEqual(flex.layout.padding.left, 24, 'flex padding-left copies from CSS');
  assert.strictEqual(flex.layout.padding.right, 24, 'flex padding-right copies from CSS');
  // The margin bug: children are 16px apart but CSS gap is 0. The gap must be
  // refined from measured geometry, otherwise Figma reflows them touching.
  assert.strictEqual(flex.layout.gap, 16,
    `child CSS margins must fold into auto-layout gap (CSS gap is 0)`);
  // Trailing margin of the last child folds into the bottom inset (24+16=40)
  // so the Figma reflow reproduces the capture exactly.
  assert.strictEqual(flex.layout.padding.bottom, 40,
    `bottom inset = padding + trailing child margin, got ${flex.layout.padding.bottom}`);

  const block = deepFind(payload.root, (n) => /blockcard/.test(n.name || ''));
  assert(block, 'block card present in payload');
  assert.strictEqual(block.layout.mode, 'VERTICAL', 'block stack recovered as auto-layout');
  assert.strictEqual(block.layout.gap, 16, 'block stack gap from measured spacing');
  assert.strictEqual(block.layout.padding.top, 24, 'block stack padding-top from measured inset');
  assert.strictEqual(block.layout.padding.left, 24, 'block stack padding-left from measured inset');
  console.log('✅ A capture: flex padding + folded child margins → gap 16; block stack padding/gap intact');
}

// -------------------------------------------------------------- B: import
function makeEnv() {
  let nextId = 1;
  const makeNode = (type) => ({
    id: String(nextId++), type, name: '', x: 0, y: 0, width: 100, height: 100,
    children: [], fills: [], strokes: [], effects: [],
    appendChild(c) {
      if (c.parent) {
        const i = c.parent.children.indexOf(c);
        if (i >= 0) c.parent.children.splice(i, 1);
      }
      this.children.push(c); c.parent = this;
    },
    insertChild(i, c) {
      if (c.parent) {
        const old = c.parent.children.indexOf(c);
        if (old >= 0) c.parent.children.splice(old, 1);
      }
      this.children.splice(i, 0, c); c.parent = this;
    },
    remove() {
      if (!this.parent) return;
      const i = this.parent.children.indexOf(this);
      if (i >= 0) this.parent.children.splice(i, 1);
      this.parent = null;
    },
    resize(w, h) { this.width = w; this.height = h; },
    rescale(s) { this.width *= s; this.height *= s; },
    setRangeFontName() {}, setRangeFontSize() {}, setRangeFills() {},
    setRangeLetterSpacing() {}, setRangeLineHeight() {}, setRangeTextDecoration() {},
  });
  const page = makeNode('PAGE'); page.selection = [];
  const messages = [];
  const figma = {
    showUI() {},
    ui: { postMessage(m) { messages.push(m); }, onmessage: null },
    currentPage: page,
    viewport: { center: { x: 0, y: 0 }, scrollAndZoomIntoView() {} },
    notify() { throw new Error('notify must not be used'); },
    async loadFontAsync(f) {
      const ok = new Set(['Inter|Regular', 'Inter|Medium', 'Inter|Semi Bold', 'Inter|Bold', 'Inter|Italic']);
      if (!ok.has(`${f.family}|${f.style}`)) throw new Error('no font');
    },
    createFrame() { return makeNode('FRAME'); },
    createText() { return makeNode('TEXT'); },
    createRectangle() { return makeNode('RECTANGLE'); },
    createImage() { return { hash: 'h' }; },
    createNodeFromSvg() {
      const n = makeNode('FRAME'); n.width = 24; n.height = 24;
      const inner = makeNode('VECTOR'); inner.width = 24; inner.height = 24;
      n.appendChild(inner);
      return n;
    },
  };
  const sandbox = { figma, __html__: '', console, Uint8Array, Set, Map, Promise };
  vm.createContext(sandbox);
  vm.runInContext(CODE, sandbox);
  return { figma, page, messages };
}

const textNode = (name, x, y, w, h) => ({
  type: 'TEXT', name, rect: { x, y, w, h },
  text: { align: 'LEFT', lines: 1, runs: [{ content: name, fontFamily: 'Inter', fontWeight: 400, italic: false, fontSize: 16, color: 'rgb(0,0,0)', letterSpacing: 0 }] },
});

async function importTest() {
  const { figma, page } = makeEnv();
  const payload = {
    schema: 'claude2figma', schemaVersion: 1, title: 'Padding import', slideCount: 1,
    capturedAt: '2026-10-29T00:00:00.000Z',
    root: {
      type: 'FRAME', name: 'Deck', role: 'deck', rect: { x: 0, y: 0, w: 600, h: 400 },
      children: [{
        type: 'FRAME', name: 'Slide 1', role: 'slide', rect: { x: 0, y: 0, w: 600, h: 400 },
        layout: { mode: 'VERTICAL', gap: 16, padding: { top: 24, right: 24, bottom: 24, left: 24 }, primaryAlign: 'MIN', counterAlign: 'MIN' },
        children: [
          {
            type: 'FRAME', name: 'card', rect: { x: 24, y: 24, w: 552, h: 120 },
            layout: { mode: 'VERTICAL', gap: 8, padding: { top: 12, right: 12, bottom: 12, left: 12 }, primaryAlign: 'MIN', counterAlign: 'MIN' },
            children: [textNode('line one', 36, 36, 528, 20), textNode('line two', 36, 64, 528, 20)],
          },
          textNode('below the card', 24, 160, 552, 24),
        ],
      }],
    },
  };
  await figma.ui.onmessage({ type: 'import', payload, options: undefined });
  assert.strictEqual(page.children.length, 1, 'one slide imported');
  const slide = page.children[0];

  assert.strictEqual(slide.layoutMode, 'VERTICAL', 'slide gets auto-layout mode');
  assert.strictEqual(slide.itemSpacing, 16, 'slide itemSpacing = layout gap');
  assert.strictEqual(slide.paddingTop, 24, 'slide paddingTop copies');
  assert.strictEqual(slide.paddingRight, 24, 'slide paddingRight copies');
  assert.strictEqual(slide.paddingBottom, 24, 'slide paddingBottom copies');
  assert.strictEqual(slide.paddingLeft, 24, 'slide paddingLeft copies');

  const card = slide.children.find((c) => c.name === 'card');
  assert(card, 'card frame built inside slide');
  assert.strictEqual(card.layoutMode, 'VERTICAL', 'card gets auto-layout mode');
  assert.strictEqual(card.itemSpacing, 8, 'card itemSpacing = layout gap');
  assert.strictEqual(card.paddingTop, 12, 'card paddingTop copies');
  assert.strictEqual(card.paddingLeft, 12, 'card paddingLeft copies');
  assert.strictEqual(card.paddingBottom, 12, 'card paddingBottom copies');
  console.log('✅ B import: layout padding + gap applied to real Figma frame properties');
}

(async () => {
  await captureTest();
  await importTest();
  console.log('✅ padding-margin-test passed (capture folds margins → import applies padding/gap)');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
