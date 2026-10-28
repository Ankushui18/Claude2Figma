// Native Figma-canvas export test: run figma-plugin/code.js against a mock
// Figma document, list its frames, then export selected/checklist scopes to
// the same Claude2Figma JSON used by Claude captures.
//   node test/figma-export-test.js
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const posted = [];
let nextId = 1;

function bbox(x, y, width, height) {
  return { x, y, width, height };
}

function makeNode(type, props = {}) {
  const node = {
    id: props.id || String(nextId++),
    type,
    name: props.name || type,
    x: props.x || 0,
    y: props.y || 0,
    width: props.width == null ? 100 : props.width,
    height: props.height == null ? 100 : props.height,
    absoluteBoundingBox: props.absoluteBoundingBox || bbox(props.x || 0, props.y || 0, props.width == null ? 100 : props.width, props.height == null ? 100 : props.height),
    visible: props.visible !== false,
    children: [],
    fills: props.fills || [],
    strokes: props.strokes || [],
    effects: props.effects || [],
    opacity: props.opacity == null ? 1 : props.opacity,
    layoutMode: props.layoutMode || 'NONE',
    itemSpacing: props.itemSpacing || 0,
    paddingTop: props.paddingTop || 0,
    paddingRight: props.paddingRight || 0,
    paddingBottom: props.paddingBottom || 0,
    paddingLeft: props.paddingLeft || 0,
    primaryAxisAlignItems: props.primaryAxisAlignItems || 'MIN',
    counterAxisAlignItems: props.counterAxisAlignItems || 'MIN',
    clipsContent: !!props.clipsContent,
    parent: null,
  };
  Object.assign(node, props.extra || {});
  for (const child of props.children || []) {
    node.children.push(child);
    child.parent = node;
  }
  return node;
}

const solid = (r, g, b, opacity = 1) => ({ type: 'SOLID', color: { r, g, b }, opacity, visible: true });

const helloText = makeNode('TEXT', {
  id: 'text-1', name: 'Hello label', x: 140, y: 90, width: 300, height: 48,
  absoluteBoundingBox: bbox(140, 90, 300, 48),
  extra: {
    characters: 'Hello Figma',
    fontName: { family: 'Inter', style: 'SemiBold' },
    fontSize: 32,
    fills: [solid(1, 1, 1)],
    letterSpacing: { value: 1, unit: 'PIXELS' },
    lineHeight: { value: 40, unit: 'PIXELS' },
    textDecoration: 'NONE',
    textAlignHorizontal: 'LEFT',
    textAutoResize: 'WIDTH_AND_HEIGHT',
    getStyledTextSegments() {
      return [{
        characters: 'Hello Figma', start: 0, end: 11,
        fontName: { family: 'Inter', style: 'SemiBold' }, fontSize: 32,
        fills: [solid(1, 1, 1)], letterSpacing: { value: 1, unit: 'PIXELS' },
        lineHeight: { value: 40, unit: 'PIXELS' }, textDecoration: 'NONE', fontStyle: 'NORMAL',
      }];
    },
  },
});
const imageRect = makeNode('RECTANGLE', {
  id: 'image-1', name: 'Hero image', x: 140, y: 170, width: 240, height: 140,
  absoluteBoundingBox: bbox(140, 170, 240, 140),
  fills: [{ type: 'IMAGE', imageHash: 'hero-hash', scaleMode: 'FILL', visible: true }],
  extra: { cornerRadius: 18 },
});
const icon = makeNode('VECTOR', {
  id: 'vector-1', name: 'Sun icon', x: 420, y: 170, width: 48, height: 48,
  absoluteBoundingBox: bbox(420, 170, 48, 48),
  extra: {
    async exportAsync(settings) {
      assert.strictEqual(settings.format, 'SVG_STRING');
      return '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><circle cx="24" cy="24" r="20"/></svg>';
    },
  },
});
const frameA = makeNode('FRAME', {
  id: 'frame-a', name: 'Desktop Home', x: 100, y: 50, width: 1280, height: 720,
  absoluteBoundingBox: bbox(100, 50, 1280, 720),
  fills: [solid(0.05, 0.05, 0.08)],
  layoutMode: 'VERTICAL', itemSpacing: 16,
  paddingTop: 40, paddingRight: 40, paddingBottom: 40, paddingLeft: 40,
  clipsContent: true,
  children: [helloText, imageRect, icon],
});
const section = makeNode('SECTION', {
  id: 'section-1', name: 'Core screens', x: 80, y: 30, width: 1320, height: 760,
  absoluteBoundingBox: bbox(80, 30, 1320, 760),
  children: [frameA],
});
const frameB = makeNode('FRAME', {
  id: 'frame-b', name: 'Mobile Home', x: 1500, y: 50, width: 390, height: 844,
  absoluteBoundingBox: bbox(1500, 50, 390, 844),
  fills: [solid(1, 1, 1)],
  children: [],
});
const frameC = makeNode('FRAME', {
  id: 'frame-c', name: 'Settings', x: 0, y: 0, width: 1024, height: 768,
  absoluteBoundingBox: bbox(0, 0, 1024, 768),
  fills: [solid(0.9, 0.95, 1)],
  children: [],
});
const page1 = makeNode('PAGE', { id: 'page-1', name: 'Core', children: [section, frameB] });
page1.selection = [frameA];
const page2 = makeNode('PAGE', { id: 'page-2', name: 'More', children: [frameC] });
page2.selection = [];

const figma = {
  showUI() {},
  ui: { postMessage(message) { posted.push(message); }, onmessage: null },
  root: { name: 'Varis Studio', children: [page1, page2] },
  currentPage: page1,
  viewport: { center: { x: 0, y: 0 }, scrollAndZoomIntoView() {} },
  notify() { throw new Error('notify must not be used'); },
  async loadAllPagesAsync() {},
  async loadFontAsync() {},
  getImageByHash(hash) {
    assert.strictEqual(hash, 'hero-hash');
    return { async getBytesAsync() { return new Uint8Array([1, 2, 3]); } };
  },
  createFrame() { return makeNode('FRAME'); },
  createText() { return makeNode('TEXT'); },
  createRectangle() { return makeNode('RECTANGLE'); },
  createImage() { return { hash: 'unused' }; },
  createNodeFromSvg() { return makeNode('FRAME'); },
};

const sandbox = { figma, __html__: '', console, Uint8Array, Set, Map, Promise };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'figma-plugin', 'code.js'), 'utf8'), sandbox);

(async () => {
  await figma.ui.onmessage({ type: 'get-figma-canvas' });
  const listing = posted.find((m) => m.type === 'figma-canvas');
  assert(listing, 'canvas listing posted');
  assert.strictEqual(listing.pages.length, 2);
  assert.strictEqual(listing.pages[0].frames.map((f) => f.id).join('|'), 'frame-a|frame-b',
    'frames inside a section are listed as artboards');
  assert.strictEqual(listing.selection.map((n) => n.id).join('|'), 'frame-a');

  await figma.ui.onmessage({
    type: 'export-figma-canvas',
    options: { scope: 'checklist', frameIds: ['frame-a', 'frame-c'] },
  });
  const exported = posted.filter((m) => m.type === 'figma-export').pop();
  assert(exported, 'checklist export posted');
  assert.strictEqual(exported.slides, 2);
  const payload = JSON.parse(exported.json);
  assert.strictEqual(payload.schema, 'claude2figma');
  assert.strictEqual(payload.captureReport.detectionMethod, 'figma-plugin');
  assert.strictEqual(payload.root.role, 'deck');
  assert.strictEqual(payload.root.children.map((s) => s.name).join('|'), 'Desktop Home|Settings');

  const desktop = payload.root.children[0];
  assert.strictEqual(desktop.rect.w, 1280);
  assert.strictEqual(desktop.rect.h, 720);
  assert.strictEqual(desktop.layout.mode, 'VERTICAL');
  const text = desktop.children.find((n) => n.type === 'TEXT');
  assert(text && text.text.runs[0].content === 'Hello Figma', 'native text exported');
  assert.strictEqual(text.text.runs[0].fontWeight, 600);
  assert.strictEqual(text.rect.x, 40, 'text is positioned relative to its artboard');
  assert.strictEqual(text.rect.y, 40);
  const image = desktop.children.find((n) => n.type === 'IMAGE');
  assert(image && image.fill.bytes === 'AQID', 'image bytes are embedded base64');
  const vector = desktop.children.find((n) => n.type === 'VECTOR');
  assert(vector && vector.svg.includes('<circle'), 'vector exported as SVG');

  await figma.ui.onmessage({ type: 'export-figma-canvas', options: { scope: 'selection' } });
  const selectionExport = posted.filter((m) => m.type === 'figma-export').pop();
  assert(selectionExport && selectionExport.slides === 1, 'selection export has one artboard');
  assert.strictEqual(JSON.parse(selectionExport.json).root.name, 'Desktop Home');

  console.log('✅ figma-export-test passed (list → checklist/selection → Claude2Figma JSON)');
})().catch((e) => { console.error('❌', e); process.exit(1); });
