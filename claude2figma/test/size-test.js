// Artboard-size option test: imports the sample deck (1280×720 slides)
// through the real plugin with different options and checks that frames
// come out at the chosen size with the whole design scaled inside.
//   node test/size-test.js
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const CODE = fs.readFileSync(path.join(__dirname, '..', 'figma-plugin', 'code.js'), 'utf8');
const SAMPLE = () => JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'sample', 'sample-deck.deck.json'), 'utf8'));

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

const approx = (actual, expected, label) =>
  assert(Math.abs(actual - expected) <= 1.5, `${label}: expected ~${expected}, got ${actual}`);

// In the sample, slide 1 children include the gradient card at (80,290) 520x150
// and the title text at (80,70). After scaling by k (and any centering
// offset), those are what we measure.
function cardOf(slideNode) {
  return slideNode.children.find((c) => c.name === 'div.card');
}
function titleOf(slideNode) {
  return slideNode.children.find((c) => c.type === 'TEXT');
}

async function scenario(options, check) {
  const { figma, page, messages } = makeEnv();
  await figma.ui.onmessage({ type: 'import', payload: SAMPLE(), options });
  assert.strictEqual(page.children.length, 2, 'two slides imported');
  check(page.children[0], page, messages.find((m) => m.type === 'result'));
}

(async () => {
  // 1 — original (no options at all): unchanged behavior
  await scenario(undefined, (s) => {
    approx(s.width, 1280, 'original width');
    approx(s.height, 720, 'original height');
    approx(cardOf(s).width, 520, 'original card width');
    const cardText = cardOf(s).children.find((c) => c.type === 'TEXT');
    assert(cardText, 'sample card contains text');
    assert.strictEqual(cardText.layoutSizingVertical, 'HUG',
      'text inside Auto Layout hugs vertically');
    assert(['HUG', 'FILL'].includes(cardText.layoutSizingHorizontal),
      'text inside Auto Layout is not forced FIXED horizontally');
  });
  console.log('✅ original size keeps 1280×720');

  // 2 — match width 1920: uniform 150% scale, height follows the ratio
  await scenario({ fit: 'width', targetW: 1920, targetH: 1080 }, (s) => {
    approx(s.width, 1920, 'width-fit frame width');
    approx(s.height, 1080, 'width-fit frame height (720*1.5)');
    approx(cardOf(s).width, 780, 'width-fit card scaled 520*1.5');
    approx(cardOf(s).x, 120, 'width-fit card x scaled 80*1.5');
  });
  console.log('✅ match-width 1920 scales design to 1920×1080 (150%)');

  // 2b — the requested 1600 desktop breakpoint, exact frame + scaled tree.
  await scenario({ fit: 'fit', targetW: 1600, targetH: 900 }, (s) => {
    approx(s.width, 1600, '1600 frame width');
    approx(s.height, 900, '1600 frame height');
    approx(cardOf(s).width, 650, '1600 card scaled 520*1.25');
  });
  console.log('✅ 1600×900 import scales the design to an exact 1600px frame');

  // 3 — fit inside 1000×1000: whole design visible, centered vertically
  await scenario({ fit: 'fit', targetW: 1000, targetH: 1000 }, (s) => {
    approx(s.width, 1000, 'fit frame width');
    approx(s.height, 1000, 'fit frame height');
    const k = 1000 / 1280;                       // 0.78125
    approx(cardOf(s).width, 520 * k, 'fit card width');
    const expectedTitleY = 70 * k + (1000 - 720 * k) / 2;  // centered
    approx(titleOf(s).y, expectedTitleY, 'fit title centered vertically');
  });
  console.log('✅ fit-inside 1000×1000 centers the whole design');

  // 4 — fill 1000×1000: covers the frame, center-cropped (negative x offset)
  await scenario({ fit: 'fill', targetW: 1000, targetH: 1000 }, (s) => {
    approx(s.width, 1000, 'fill frame width');
    approx(s.height, 1000, 'fill frame height');
    const k = 1000 / 720;                        // 1.3889 (height drives)
    const expectedTitleX = 80 * k + (1000 - 1280 * k) / 2; // negative => cropped
    approx(titleOf(s).x, expectedTitleX, 'fill title x (center crop)');
    assert(expectedTitleX < 0, 'fill should crop on x for this ratio');
  });
  console.log('✅ fill 1000×1000 covers frame and crops sides');

  // 5 — mobile preset by width: 390 wide phone frames
  await scenario({ fit: 'width', targetW: 390, targetH: 844 }, (s) => {
    approx(s.width, 390, 'mobile frame width');
    approx(s.height, Math.round(720 * (390 / 1280)), 'mobile frame height');
  });
  console.log('✅ iPhone-width import produces 390px-wide frames');

  // 6 — stretch: frame is exactly the target, children stretch per-axis
  await scenario({ fit: 'stretch', targetW: 800, targetH: 800 }, (s) => {
    approx(s.width, 800, 'stretch width');
    approx(s.height, 800, 'stretch height');
    approx(cardOf(s).width, 520 * (800 / 1280), 'stretch card width (kx)');
    approx(cardOf(s).height, 150 * (800 / 720), 'stretch card height (ky)');
  });
  console.log('✅ stretch makes exact-size frames');

  // 7 — junk options are safe (falls back / clamps)
  await scenario({ fit: 'width', targetW: -5, targetH: 'abc' }, (s) => {
    assert(s.width >= 16 && s.width <= 10000, 'width clamped to sane range');
  });
  console.log('✅ invalid sizes are clamped safely');

  // 8 — per-artboard overrides: first stays original, second becomes
  // an exact phone-sized frame, ignoring the 1920px global setting.
  await scenario({
    fit: 'width', targetW: 1920, targetH: 1080,
    slides: [
      { fit: 'original' },
      { fit: 'fit', targetW: 390, targetH: 844 },
    ],
  }, (_s, page, result) => {
    approx(page.children[0].width, 1280, 'override slide 1 width');
    approx(page.children[0].height, 720, 'override slide 1 height');
    approx(page.children[1].width, 390, 'override slide 2 width');
    approx(page.children[1].height, 844, 'override slide 2 height');
    assert(result && Array.isArray(result.frameSizes), 'result reports frame sizes');
    assert.strictEqual(result.frameSizes.length, 2);
    assert.strictEqual(result.frameSizes[0].width, 1280);
    assert.strictEqual(result.frameSizes[1].width, 390);
  });
  console.log('✅ each artboard can use a different imported size');

  // 9 — sparse override arrays fall back to the global setting.
  await scenario({
    fit: 'width', targetW: 640, targetH: 360,
    slides: [null, { fit: 'original' }],
  }, (_s, page) => {
    approx(page.children[0].width, 640, 'sparse slide uses global width');
    approx(page.children[0].height, 360, 'sparse slide uses global height');
    approx(page.children[1].width, 1280, 'explicit original slide width');
  });
  console.log('✅ missing per-artboard entries safely use the global size');

  // 10 — selected-artboard import: disabled slides are skipped entirely.
  {
    const { figma, page, messages } = makeEnv();
    await figma.ui.onmessage({
      type: 'import', payload: SAMPLE(),
      options: {
        slides: [
          { fit: 'original', enabled: false },
          { fit: 'fit', targetW: 390, targetH: 844, enabled: true },
        ],
      },
    });
    assert.strictEqual(page.children.length, 1, 'only the checked artboard imports');
    assert.strictEqual(page.children[0].name, '02 · Details');
    approx(page.children[0].width, 390, 'selected artboard width');
    approx(page.children[0].height, 844, 'selected artboard height');
    const result = messages.find((m) => m.type === 'result');
    assert(result && result.slides === 1 && result.frameSizes.length === 1,
      'result reports only the selected artboard');
  }
  console.log('✅ unchecked artboards are skipped at import');

  // 11 — a leaf decorated div is a rectangle layer, and an exact non-flex
  // text stack becomes a true Auto Layout frame with hugging text.
  {
    const textNode = (name, y) => ({
      type: 'TEXT', name, rect: { x: 10, y, w: 100, h: 20 },
      text: {
        runs: [{
          content: name, fontFamily: 'Inter', fontWeight: 400, italic: false,
          fontSize: 14, color: 'rgb(0,0,0)', letterSpacing: 0,
        }],
        align: 'LEFT', lines: 1,
      },
    });
    const payload = {
      schema: 'claude2figma', schemaVersion: 1, title: 'Clean import', slideCount: 1,
      root: {
        type: 'FRAME', name: 'Clean Screen', role: 'slide',
        rect: { x: 0, y: 0, w: 220, h: 180 },
        layout: { mode: 'NONE', gap: 0, padding: { top: 0, right: 0, bottom: 0, left: 0 } },
        children: [
          {
            type: 'FRAME', name: 'text-stack', rect: { x: 0, y: 0, w: 200, h: 100 },
            layout: { mode: 'NONE', gap: 0, padding: { top: 0, right: 0, bottom: 0, left: 0 } },
            fill: { type: 'SOLID', color: 'rgb(255,255,255)' },
            children: [textNode('One', 10), textNode('Two', 40), textNode('Three', 70)],
          },
          {
            type: 'VECTOR', name: 'icon', rect: { x: 60, y: 120, w: 24, h: 24 },
            svg: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path d="M0 0h24v24H0z"/></svg>',
          },
          {
            type: 'FRAME', name: 'color-chip', rect: { x: 10, y: 120, w: 40, h: 24 },
            layout: { mode: 'NONE', gap: 0, padding: { top: 0, right: 0, bottom: 0, left: 0 } },
            fill: { type: 'SOLID', color: 'rgb(255,0,0)' }, children: [],
          },
        ],
      },
    };
    const { figma, page, messages } = makeEnv();
    await figma.ui.onmessage({ type: 'import', payload, options: { fit: 'original' } });
    assert.strictEqual(page.children.length, 1);
    const root = page.children[0];
    const stack = root.children.find((c) => c.name === 'text-stack');
    const chip = root.children.find((c) => c.name === 'color-chip');
    assert(stack && stack.type === 'FRAME', 'stack remains a frame');
    assert.strictEqual(stack.layoutMode, 'VERTICAL', 'exact stack inferred as Auto Layout');
    assert(stack.children.every((c) => c.layoutSizingHorizontal === 'HUG'
      && c.layoutSizingVertical === 'HUG'), 'single-line stack text hugs on both axes');
    assert(chip && chip.type === 'RECTANGLE', 'leaf frame becomes a rectangle');
    const icon = root.children.find((c) => c.name === 'icon');
    assert(icon && icon.type === 'VECTOR', 'one-path SVG frame unwraps to its vector');
    approx(icon.x, 60, 'unwrapped SVG x');
    approx(icon.y, 120, 'unwrapped SVG y');
    const result = messages.find((m) => m.type === 'result');
    assert(result && result.inferredAutoLayouts >= 1, 'result reports recovered Auto Layout');
  }
  console.log('✅ leaf/SVG frames become shapes and exact text stacks become Auto Layout');

  // 12 — built artboards do not retain a full-size background shell:
  // its surface moves to the artboard and its content becomes direct layers.
  {
    const textNode = (name, x, y, w, h) => ({
      type: 'TEXT', name, rect: { x, y, w, h },
      text: {
        runs: [{
          content: name, fontFamily: 'Inter', fontWeight: 400, italic: false,
          fontSize: 14, color: 'rgb(255,255,255)', letterSpacing: 0,
        }],
        align: 'LEFT', lines: 1,
      },
    });
    const payload = {
      schema: 'claude2figma', schemaVersion: 1, title: 'No wrapper artboard', slideCount: 1,
      root: {
        type: 'FRAME', name: 'Direct Content Screen', role: 'slide',
        rect: { x: 0, y: 0, w: 300, h: 200 },
        layout: { mode: 'NONE', gap: 0, padding: { top: 0, right: 0, bottom: 0, left: 0 } },
        fill: { type: 'SOLID', color: 'rgb(200,20,20)' },
        children: [
          {
            type: 'FRAME', name: 'div.background-shell',
            rect: { x: 0, y: 0, w: 300, h: 200 },
            layout: { mode: 'VERTICAL', gap: 10, padding: { top: 20, right: 20, bottom: 20, left: 20 } },
            fill: { type: 'SOLID', color: 'rgb(20,40,200)' },
            children: [
              textNode('Direct title', 20, 20, 160, 28),
              textNode('Direct body', 20, 58, 180, 24),
            ],
          },
          textNode('Direct badge', 230, 20, 50, 20),
        ],
      },
    };
    const { figma, page, messages } = makeEnv();
    await figma.ui.onmessage({ type: 'import', payload, options: { fit: 'original' } });
    assert.strictEqual(page.children.length, 1);
    const root = page.children[0];
    assert.strictEqual(root.children.map((c) => c.name).join('|'), 'Direct title|Direct body|Direct badge',
      'artboard content is not nested inside a background wrapper');
    assert(root.children.every((c) => c.type === 'TEXT'), 'no extra direct wrapper frame is built');
    approx(root.children[0].x, 20, 'direct title x');
    approx(root.children[0].y, 20, 'direct title y');
    approx(root.children[2].x, 230, 'direct badge x');
    assert(root.fills[0] && root.fills[0].color
      && Math.abs(root.fills[0].color.b - 200 / 255) <= 0.01,
      'background shell fill transfers to the artboard');
    const result = messages.find((m) => m.type === 'result');
    assert(result && result.layersRemoved >= 1, 'result reports the removed wrapper');
  }
  console.log('✅ built artboard has direct content instead of a background wrapper');

  console.log('✅ size-test passed');
})().catch((e) => { console.error('❌', e); process.exit(1); });
