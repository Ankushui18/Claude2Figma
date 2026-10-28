// Smoke test: run the real figma-plugin/code.js against a mock `figma`
// global in Node and import sample/sample-deck.deck.json.
//   node test/mock-figma-test.js
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

let nextId = 1;
const createdCounts = { FRAME: 0, TEXT: 0, RECTANGLE: 0, SVG: 0, IMAGE: 0 };
const loadedFonts = [];
const postedMessages = [];
let notifyMessage = '';

function makeNode(type) {
  const node = {
    id: String(nextId++),
    type,
    name: '',
    x: 0, y: 0, width: 100, height: 100,
    children: [],
    fills: [], strokes: [], effects: [],
    appendChild(child) { this.children.push(child); child.parent = this; },
    resize(w, h) { this.width = w; this.height = h; },
    rescale(s) { this.width *= s; this.height *= s; },
    setRangeFontName() {}, setRangeFontSize() {}, setRangeFills() {},
    setRangeLetterSpacing() {}, setRangeLineHeight() {}, setRangeTextDecoration() {},
  };
  return node;
}

const currentPage = makeNode('PAGE');
currentPage.selection = [];

const AVAILABLE_FONTS = new Set([
  'Inter|Regular', 'Inter|Medium', 'Inter|Semi Bold', 'Inter|Bold', 'Inter|Italic', 'Inter|Bold Italic',
  'Roboto|Regular', 'Roboto|Bold',
]);

const figma = {
  showUI() {},
  ui: { postMessage(m) { postedMessages.push(m); }, onmessage: null },
  currentPage,
  viewport: { center: { x: 0, y: 0 }, scrolled: null, scrollAndZoomIntoView(nodes) { this.scrolled = nodes; } },
  notify(msg) { notifyMessage = msg; },
  async loadFontAsync(font) {
    loadedFonts.push(font);
    if (!AVAILABLE_FONTS.has(`${font.family}|${font.style}`)) {
      throw new Error(`Font not available: ${font.family} ${font.style}`);
    }
  },
  createFrame() { createdCounts.FRAME += 1; return makeNode('FRAME'); },
  createText() { createdCounts.TEXT += 1; return makeNode('TEXT'); },
  createRectangle() { createdCounts.RECTANGLE += 1; return makeNode('RECTANGLE'); },
  createImage(bytes) {
    createdCounts.IMAGE += 1;
    assert(bytes instanceof Uint8Array && bytes.length > 100, 'image bytes should be decoded');
    // PNG signature check on the sample deck image
    assert.deepStrictEqual([...bytes.slice(0, 4)], [137, 80, 78, 71], 'sample image should be a PNG');
    return { hash: 'fakehash' };
  },
  createNodeFromSvg(svg) {
    createdCounts.SVG += 1;
    assert(svg.includes('<svg'), 'svg string expected');
    const n = makeNode('FRAME'); n.width = 24; n.height = 24; return n;
  },
};

const sandbox = { figma, __html__: '<html></html>', console, Uint8Array, Set, Map, Promise };
vm.createContext(sandbox);
const code = fs.readFileSync(path.join(__dirname, '..', 'figma-plugin', 'code.js'), 'utf8');
vm.runInContext(code, sandbox);

(async () => {
  const payload = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'sample', 'sample-deck.deck.json'), 'utf8'));

  assert.strictEqual(typeof figma.ui.onmessage, 'function', 'plugin should register ui.onmessage');
  await figma.ui.onmessage({ type: 'import', payload });

  const result = postedMessages.find((m) => m.type === 'result');
  assert(result, 'expected a result message');
  assert.strictEqual(result.cancelled, false);
  assert.strictEqual(result.slides, 2, 'two top-level slides');
  assert.strictEqual(result.failedImages, 0);
  assert.strictEqual(result.failedVectors, 0);
  assert.strictEqual(result.missingFonts.length, 0, 'Inter should resolve');

  assert.strictEqual(currentPage.children.length, 2);
  assert.strictEqual(currentPage.children[0].name, '01 · Welcome');
  assert.strictEqual(currentPage.children[1].name, '02 · Details');
  assert(currentPage.children[1].y > currentPage.children[0].y, 'slides stacked vertically');
  assert.strictEqual(currentPage.selection.length, 2);

  assert(createdCounts.TEXT >= 8, `expected >=8 text nodes, got ${createdCounts.TEXT}`);
  assert(createdCounts.IMAGE >= 2, 'one raster image per slide');
  assert(createdCounts.SVG >= 2, 'one vector per slide');
  assert.strictEqual(notifyMessage, '', 'plugin must not popup toast notifications');
  assert.strictEqual(currentPage.children[0].clipsContent, true, 'slide frames clip like artboards');

  // Bad payload should surface an error, not crash.
  await figma.ui.onmessage({ type: 'import', payload: { hello: 'world' } });
  assert(postedMessages.some((m) => m.type === 'error'), 'invalid deck should post error');

  console.log('✅ mock-figma-test passed');
  console.log('   created:', JSON.stringify(createdCounts));
  console.log('   fonts:', [...new Set(loadedFonts.map((f) => `${f.family} ${f.style}`))].join(', '));
  console.log('   result:', JSON.stringify(result));
})().catch((e) => { console.error('❌', e); process.exit(1); });
