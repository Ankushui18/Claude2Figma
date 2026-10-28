// Layer-cleanup test: pruneTree() must remove do-nothing wrapper frames
// while keeping every visible/decorated/structural layer.
//   node test/prune-test.js
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const figma = {
  showUI() {},
  ui: { postMessage() {}, onmessage: null },
  currentPage: { children: [], appendChild() {} },
  viewport: { center: { x: 0, y: 0 }, scrollAndZoomIntoView() {} },
  notify() { throw new Error('notify must not be used'); },
};
const sandbox = { figma, __html__: '', console };
vm.createContext(sandbox);
vm.runInContext(
  fs.readFileSync(path.join(__dirname, '..', 'figma-plugin', 'code.js'), 'utf8'),
  sandbox);

const frame = (name, children, extra = {}) => ({
  type: 'FRAME', name, rect: { x: 0, y: 0, w: 100, h: 100 },
  layout: { mode: 'NONE', gap: 0, padding: { top: 0, right: 0, bottom: 0, left: 0 } },
  children, ...extra,
});
const text = (name, rect = { x: 0, y: 0, w: 50, h: 20 }) => ({
  type: 'TEXT', name, rect,
  text: { runs: [{ content: name, fontFamily: 'Inter', fontWeight: 400, italic: false, fontSize: 14, color: 'rgb(0,0,0)', letterSpacing: 0 }], align: 'LEFT', lines: 1 },
});

const root = frame('Slide', [
  // double wrapper around one text -> both must go
  frame('wrapA', [frame('wrapB', [text('Hello')])]),
  // empty invisible frame -> deleted
  frame('empty', []),
  // decorated leaf frame (a visible rectangle) -> kept
  frame('colored-box', [], { fill: { type: 'SOLID', color: 'rgb(255,0,0)' } }),
  // plain multi-child wrapper -> dissolved, children promoted
  frame('group-wrap', [text('One'), text('Two')]),
  // auto-layout wrapper -> kept (it carries layout meaning)
  frame('row', [text('L'), text('R')],
    { layout: { mode: 'HORIZONTAL', gap: 8, padding: { top: 4, right: 4, bottom: 4, left: 4 } } }),
  // A clipping frame is unnecessary when nothing overflows, but must stay
  // when a descendant actually extends beyond its bounds.
  frame('clipper', [text('Inside', { x: 80, y: 80, w: 50, h: 50 })], { clips: true }),
  frame('non-clipper', [text('NoOverflow')], { clips: true }),
  // Decorated outer host + identical inner layout -> merged; the fill moves
  // to the surviving inner frame instead of leaving duplicate artboards.
  frame('outer-bg', [
    frame('inner-layout', [text('Nested A'), text('Nested B')],
      { layout: { mode: 'VERTICAL', gap: 8, padding: { top: 0, right: 0, bottom: 0, left: 0 } } }),
  ], { fill: { type: 'SOLID', color: 'rgb(0,0,255)' } }),
], { role: 'slide', fill: { type: 'SOLID', color: 'rgb(10,10,10)' } });

sandbox.__root = root;
const before = vm.runInContext('countNodes(__root)', sandbox);
vm.runInContext('pruneTree(__root)', sandbox);
const after = vm.runInContext('countNodes(__root)', sandbox);

const names = [];
(function walk(n) { names.push(n.name); (n.children || []).forEach(walk); })(JSON.parse(JSON.stringify(root)));

assert(before > after, `layers should decrease (${before} -> ${after})`);
for (const gone of ['wrapA', 'wrapB', 'empty', 'group-wrap', 'non-clipper', 'outer-bg']) {
  assert(!names.includes(gone), `${gone} should be pruned (got: ${names.join(', ')})`);
}
for (const kept of ['Slide', 'Hello', 'colored-box', 'One', 'Two', 'row', 'L', 'R', 'clipper', 'Inside', 'NoOverflow', 'inner-layout', 'Nested A', 'Nested B']) {
  assert(names.includes(kept), `${kept} should be kept (got: ${names.join(', ')})`);
}
// slide root: Hello + colored-box + One + Two + row + clipper +
// NoOverflow + merged inner-layout = 8 direct children.
const cleanRoot = JSON.parse(JSON.stringify(root));
assert.strictEqual(cleanRoot.children.length, 8);
const merged = cleanRoot.children.find((c) => c.name === 'inner-layout');
assert(merged && merged.fill && merged.fill.color === 'rgb(0,0,255)',
  'merged inner screen inherits the outer background');

// A slide host and identical inner screen collapse into one slide frame,
// with role/name transferred to the survivor.
const innerSlide = frame('div.screen', [text('Only screen text'), text('Second line')],
  { layout: { mode: 'VERTICAL', gap: 4, padding: { top: 0, right: 0, bottom: 0, left: 0 } } });
const slideHost = frame('Actual Artboard', [innerSlide], { role: 'slide', clips: true });
sandbox.__slideHost = slideHost;
const collapsed = vm.runInContext('pruneTree(__slideHost)', sandbox);
assert.strictEqual(collapsed.name, 'Actual Artboard');
assert.strictEqual(collapsed.role, 'slide');
assert.strictEqual(collapsed.children.length, 2);

// Stronger artboard cleanup: a sole, inset, generic Auto Layout shell is
// still just a pass-through. Its contents should become direct artboard
// layers even though it is not the same size as the artboard.
const childNames = (n) => (n.children || []).map((c) => c.name).join('|');
const soleShellArtboard = frame('Sole Shell Artboard', [
  frame('div.page-shell', [
    text('Direct Title', { x: 24, y: 24, w: 200, h: 32 }),
    text('Direct Body', { x: 24, y: 68, w: 220, h: 24 }),
  ], {
    rect: { x: 12, y: 12, w: 276, h: 176 },
    layout: { mode: 'VERTICAL', gap: 12, padding: { top: 12, right: 12, bottom: 12, left: 12 } },
  }),
], {
  role: 'slide', rect: { x: 0, y: 0, w: 300, h: 200 },
  fill: { type: 'SOLID', color: 'rgb(255,255,255)' },
});
sandbox.__soleShellArtboard = soleShellArtboard;
vm.runInContext('pruneTree(__soleShellArtboard)', sandbox);
assert.strictEqual(childNames(soleShellArtboard), 'Direct Title|Direct Body',
  'sole inset artboard shell is removed');

// Absolute multi-child wrappers and wrappers whose decorations are all
// no-ops (transparent fill, zero-width stroke, invisible shadow, radius
// alone) must not survive merely because those fields exist in JSON.
const noopArtboard = frame('Noop Artboard', [
  text('Base layer', { x: 10, y: 10, w: 80, h: 20 }),
  frame('div.overlay', [
    text('Overlay A', { x: 110, y: 10, w: 60, h: 20 }),
    text('Overlay B', { x: 180, y: 10, w: 60, h: 20 }),
  ], {
    absolute: true, rect: { x: 100, y: 0, w: 160, h: 40 },
    layout: { mode: 'HORIZONTAL', gap: 10, padding: { top: 10, right: 10, bottom: 10, left: 10 } },
  }),
  frame('transparent-shell', [
    text('Noop content', { x: 10, y: 60, w: 100, h: 20 }),
  ], {
    rect: { x: 0, y: 50, w: 160, h: 40 },
    fill: { type: 'SOLID', color: 'rgba(0,0,0,0)' },
    stroke: { color: 'rgba(0,0,0,0)', width: 0 },
    shadows: [{ offsetX: 0, offsetY: 0, blur: 0, spread: 0, color: 'rgba(0,0,0,0)' }],
    cornerRadius: 24,
  }),
], { role: 'slide', rect: { x: 0, y: 0, w: 300, h: 200 } });
sandbox.__noopArtboard = noopArtboard;
vm.runInContext('pruneTree(__noopArtboard)', sandbox);
assert.strictEqual(childNames(noopArtboard), 'Base layer|Overlay A|Overlay B|Noop content',
  'absolute and no-op-decoration wrappers are removed');

// Rounded clippers are redundant only when every descendant is inside the
// rounded shape, not merely inside the wrapper's rectangular bounds.
const roundedArtboard = frame('Rounded Artboard', [
  frame('safe-rounded-clip', [
    text('Safely inside', { x: 55, y: 55, w: 70, h: 24 }),
  ], { clips: true, cornerRadius: 40, rect: { x: 0, y: 0, w: 180, h: 180 } }),
  frame('needed-rounded-clip', [
    text('Corner content', { x: 190, y: 10, w: 50, h: 24 }),
  ], { clips: true, cornerRadius: 40, rect: { x: 190, y: 0, w: 180, h: 180 } }),
], { role: 'slide', rect: { x: 0, y: 0, w: 400, h: 200 } });
sandbox.__roundedArtboard = roundedArtboard;
vm.runInContext('pruneTree(__roundedArtboard)', sandbox);
assert(childNames(roundedArtboard).includes('Safely inside'), 'safe rounded clip is dissolved');
assert(childNames(roundedArtboard).includes('needed-rounded-clip'), 'corner-clipping frame is kept');

// A rounded clip around one same-size image transfers its radius to the
// image layer itself instead of leaving an image wrapper in the artboard.
const roundedImageArtboard = frame('Rounded Image Artboard', [
  frame('rounded-image-wrap', [{
    type: 'IMAGE', name: 'Hero image', rect: { x: 20, y: 20, w: 120, h: 80 },
    fill: { type: 'IMAGE', bytes: 'abc' }, imageScaleMode: 'FILL',
  }], { clips: true, cornerRadius: 24, rect: { x: 20, y: 20, w: 120, h: 80 } }),
  text('Image caption', { x: 20, y: 120, w: 120, h: 20 }),
], { role: 'slide', rect: { x: 0, y: 0, w: 200, h: 180 } });
sandbox.__roundedImageArtboard = roundedImageArtboard;
vm.runInContext('pruneTree(__roundedImageArtboard)', sandbox);
assert.strictEqual(childNames(roundedImageArtboard), 'Hero image|Image caption',
  'rounded image wrapper is removed');
assert.strictEqual(roundedImageArtboard.children[0].cornerRadius, 24,
  'wrapper corner radius transfers to the image');

// In an Auto Layout parent, wrappers can be removed without moving other
// flow layers when they are absolute, the only flow item, or the final
// MIN-aligned flow item. A middle flow wrapper must remain.
const autoParent = frame('Auto parent', [
  text('Flow first', { x: 0, y: 0, w: 100, h: 20 }),
  frame('middle-wrap', [
    text('Middle A', { x: 0, y: 30, w: 100, h: 20 }),
    text('Middle B', { x: 0, y: 55, w: 100, h: 20 }),
  ], { rect: { x: 0, y: 30, w: 100, h: 45 } }),
  text('Flow after middle', { x: 0, y: 85, w: 120, h: 20 }),
  frame('last-wrap', [
    text('Last A', { x: 0, y: 115, w: 100, h: 20 }),
    text('Last B', { x: 0, y: 140, w: 100, h: 20 }),
  ], { rect: { x: 0, y: 115, w: 100, h: 45 } }),
  frame('absolute-wrap', [
    text('Floating layer', { x: 150, y: 10, w: 80, h: 20 }),
  ], { absolute: true, rect: { x: 150, y: 10, w: 80, h: 20 } }),
], {
  rect: { x: 0, y: 0, w: 300, h: 180 },
  layout: { mode: 'VERTICAL', gap: 10, padding: { top: 0, right: 0, bottom: 0, left: 0 }, primaryAlign: 'MIN' },
});
sandbox.__autoParent = autoParent;
vm.runInContext('pruneTree(__autoParent)', sandbox);
assert(childNames(autoParent).includes('middle-wrap'), 'middle Auto Layout flow wrapper is kept');
assert(!childNames(autoParent).includes('last-wrap'), 'last MIN-aligned flow wrapper is removed');
assert(!childNames(autoParent).includes('absolute-wrap'), 'absolute wrapper in Auto Layout is removed');
const promotedLast = autoParent.children.find((c) => c.name === 'Last A');
assert(promotedLast && promotedLast.absolute === true,
  'promoted Auto Layout children keep exact coordinates as absolute layers');

// A full-size decorated background shell behind all other artboard layers
// transfers its surface to the artboard instead of nesting real content.
const fullBleedArtboard = frame('Full Bleed Artboard', [
  frame('div.background-shell', [
    text('Full bleed title', { x: 20, y: 20, w: 160, h: 28 }),
    text('Full bleed body', { x: 20, y: 58, w: 180, h: 24 }),
  ], {
    rect: { x: 0, y: 0, w: 300, h: 200 },
    fill: { type: 'SOLID', color: 'rgb(20,40,200)' },
    layout: { mode: 'VERTICAL', gap: 10, padding: { top: 20, right: 20, bottom: 20, left: 20 } },
  }),
  text('Badge sibling', { x: 230, y: 20, w: 50, h: 20 }),
], {
  role: 'slide', rect: { x: 0, y: 0, w: 300, h: 200 },
  fill: { type: 'SOLID', color: 'rgb(200,20,20)' },
});
sandbox.__fullBleedArtboard = fullBleedArtboard;
vm.runInContext('pruneTree(__fullBleedArtboard)', sandbox);
assert.strictEqual(childNames(fullBleedArtboard), 'Full bleed title|Full bleed body|Badge sibling',
  'full-size background shell is removed from the artboard');
assert.strictEqual(fullBleedArtboard.fill.color, 'rgb(20,40,200)',
  'opaque full-size shell background transfers to the artboard');

// An opaque inner screen can replace a different outer background at the
// exact same rect; the hidden outer frame is not another artboard layer.
const opaqueInner = frame('inner-screen', [
  text('Opaque screen text', { x: 10, y: 10, w: 120, h: 20 }),
], { fill: { type: 'SOLID', color: 'rgb(0,0,255)' } });
const opaqueOuter = frame('outer-host', [opaqueInner],
  { fill: { type: 'SOLID', color: 'rgb(255,0,0)' } });
sandbox.__opaqueOuter = opaqueOuter;
const opaqueCollapsed = vm.runInContext('pruneTree(__opaqueOuter)', sandbox);
assert.strictEqual(opaqueCollapsed.name, 'inner-screen');
assert.strictEqual(opaqueCollapsed.fill.color, 'rgb(0,0,255)');

// An exact uniform block stack becomes Auto Layout; near/exact geometry is
// preserved through padding + one gap.
const stack = frame('stack', [
  text('A', { x: 10, y: 10, w: 100, h: 20 }),
  text('B', { x: 10, y: 40, w: 100, h: 20 }),
  text('C', { x: 10, y: 70, w: 100, h: 20 }),
], { rect: { x: 0, y: 0, w: 200, h: 100 }, fill: { type: 'SOLID', color: 'rgb(255,255,255)' } });
const inferRoot = frame('InferRoot', [stack], { role: 'slide' });
sandbox.__inferRoot = inferRoot;
sandbox.__inferReport = { inferredAutoLayouts: 0 };
vm.runInContext('inferAutoLayouts(__inferRoot, __inferReport)', sandbox);
assert.strictEqual(stack.layout.mode, 'VERTICAL');
assert.strictEqual(stack.layout.gap, 10);
assert.deepStrictEqual(JSON.parse(JSON.stringify(stack.layout.padding)),
  { top: 10, right: 90, bottom: 10, left: 10 });
assert.strictEqual(sandbox.__inferReport.inferredAutoLayouts, 1);

console.log(`✅ prune-test passed (${before} -> ${after} layers, artboard/full-size/Auto-Layout wrappers gone, real layers kept)`);
