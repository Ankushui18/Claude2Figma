// Serializer test (needs jsdom:  npm i --no-save jsdom  inside test/ or repo root)
// Reproduces the "blank artboards" bug: a Claude-style canvas whose screens
// live inside OPEN SHADOW ROOTS of custom artboard elements. The serializer
// must pierce the shadow trees, detect both artboards, and capture the text.
//   node test/serializer-test.js
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

let JSDOM;
for (const candidate of ['jsdom', '/tmp/dbtest/node_modules/jsdom']) {
  try { ({ JSDOM } = require(candidate)); break; } catch (_) { /* next */ }
}
if (!JSDOM) {
  console.log('⏭️  serializer-test skipped (jsdom not installed — run: npm i --no-save jsdom)');
  process.exit(0);
}

const injectSrc = fs.readFileSync(
  path.join(__dirname, '..', 'extension', 'inject.js'), 'utf8');

function rectOf(el) {
  const raw = (el.getAttribute && el.getAttribute('data-rect')) || '0,0,120,30';
  const [x, y, w, h] = raw.split(',').map(Number);
  return {
    x, y, width: w, height: h, top: y, left: x,
    right: x + w, bottom: y + h, toJSON() { return this; },
  };
}

async function main() {
  const dom = new JSDOM('<!doctype html><html><head><title>Canvas Test</title></head><body></body></html>', {
    url: 'https://example.claudeusercontent.com/canvas',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;

  // --- layout stubs (jsdom has no layout engine) ---
  window.Element.prototype.getBoundingClientRect = function () { return rectOf(this); };
  Object.defineProperty(window.HTMLElement.prototype, 'offsetWidth', {
    configurable: true, get() { return rectOf(this).width; },
  });
  window.Range.prototype.getBoundingClientRect = () =>
    ({ x: 0, y: 0, width: 120, height: 30, top: 0, left: 0, right: 120, bottom: 30 });
  window.Range.prototype.getClientRects = () => [window.Range.prototype.getBoundingClientRect()];

  // --- chrome stub: capture the outgoing payload ---
  let captured = null;
  window.chrome = {
    runtime: {
      sendMessage(msg) {
        if (msg && msg.type === 'capture-result') captured = msg.payload;
      },
    },
  };

  // --- fixture: artboard custom elements w/ shadow-DOM screens ---
  window.eval(`
    class XBoard extends HTMLElement {
      constructor() {
        super();
        const sr = this.attachShadow({ mode: 'open' });
        const label = this.getAttribute('data-board-title') || 'Board';
        sr.innerHTML =
          '<div class="screen" data-rect="0,0,800,600">' +
            '<h1 data-rect="10,10,500,48">' + label + ' SHADOW TITLE</h1>' +
            '<p data-rect="10,70,500,24">Body text living inside the shadow tree</p>' +
            '<canvas data-rect="10,110,200,100"></canvas>' +
          '</div>';
      }
    }
    customElements.define('x-board', XBoard);
    document.body.innerHTML =
      '<x-board data-label="1 · Screen A" data-board-title="Alpha" data-rect="0,0,800,600"></x-board>' +
      '<x-board data-label="2 · Screen B" data-board-title="Beta" data-rect="900,0,800,600"></x-board>' +
      '<iframe title="Framed screen" data-rect="0,700,800,600" ' +
        'srcdoc="<html><body><h2>IFRAME DESIGN TEXT</h2></body></html>"></iframe>';
  `);

  // give the srcdoc iframe a moment to load
  await new Promise((r) => setTimeout(r, 400));

  window.eval(injectSrc);
  for (let i = 0; i < 50 && !captured; i += 1) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert(captured, 'serializer should send a capture-result');
  assert.strictEqual(captured.ok, true, `capture should succeed: ${captured.error || ''}`);

  const payload = JSON.parse(captured.json);
  const report = payload.captureReport;
  console.log('   report:', JSON.stringify(report));

  assert.strictEqual(report.mode, 'artboards', 'canvas artboards should be detected');
  assert.strictEqual(payload.slideCount, 2, 'two artboards -> two slides');
  assert(report.shadowPierced >= 2, 'both shadow trees should be pierced');

  const allText = [];
  (function walk(n) {
    if (n.type === 'TEXT') allText.push((n.text.runs || []).map((r) => r.content).join(''));
    (n.children || []).forEach(walk);
  })(payload.root);
  const joined = allText.join(' | ');
  assert(joined.includes('Alpha SHADOW TITLE'), `shadow title A captured (got: ${joined})`);
  assert(joined.includes('Beta SHADOW TITLE'), 'shadow title B captured');
  assert(joined.includes('Body text living inside the shadow tree'), 'shadow body captured');

  const slideNames = payload.root.children.map((c) => c.name);
  assert.deepStrictEqual(slideNames, ['1 · Screen A', '2 · Screen B']);

  // The iframe is outside the artboards, so artboard mode skips it — but the
  // serializer must never crash on it. canvases counted either way.
  assert(report.nodes > 8, `expected real content nodes, got ${report.nodes}`);

  console.log('✅ case 1 passed (shadow piercing + artboard splitting)');
  console.log(`   slides: ${slideNames.join(', ')} · nodes: ${report.nodes}`);
}

async function iframeCase() {
  const dom = new JSDOM('<!doctype html><html><head><title>Iframe Test</title></head><body data-rect="0,0,900,700"></body></html>', {
    url: 'https://example.claudeusercontent.com/page',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  window.Element.prototype.getBoundingClientRect = function () { return rectOf(this); };
  Object.defineProperty(window.HTMLElement.prototype, 'offsetWidth', {
    configurable: true, get() { return rectOf(this).width; },
  });
  window.Range.prototype.getBoundingClientRect = () =>
    ({ x: 0, y: 0, width: 120, height: 30, top: 0, left: 0, right: 120, bottom: 30 });
  window.Range.prototype.getClientRects = () => [window.Range.prototype.getBoundingClientRect()];

  let captured = null;
  window.chrome = {
    runtime: { sendMessage(msg) { if (msg && msg.type === 'capture-result') captured = msg.payload; } },
  };
  window.eval(`
    document.body.innerHTML =
      '<iframe title="Framed screen" data-rect="0,0,800,600"></iframe>';
    const frame = document.querySelector('iframe');
    const idoc = frame.contentDocument;
    idoc.body.setAttribute('data-rect', '0,0,800,600');
    idoc.body.innerHTML =
      '<h2 data-rect="10,10,400,40">IFRAME DESIGN TEXT</h2>' +
      '<p data-rect="10,60,400,24">inside the frame</p>';
    // patch the inner realm's layout too (separate prototypes per window)
    const iw = frame.contentWindow;
    iw.Element.prototype.getBoundingClientRect = window.Element.prototype.getBoundingClientRect;
    Object.defineProperty(iw.HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get() { return window.Element.prototype.getBoundingClientRect.call(this).width; },
    });
  `);
  await new Promise((r) => setTimeout(r, 100));
  window.eval(injectSrc);
  for (let i = 0; i < 50 && !captured; i += 1) await new Promise((r) => setTimeout(r, 100));
  assert(captured && captured.ok, 'iframe page capture should succeed');
  const payload = JSON.parse(captured.json);
  console.log('   iframe report:', JSON.stringify(payload.captureReport));
  const texts = [];
  (function walk(n) {
    if (n.type === 'TEXT') texts.push((n.text.runs || []).map((r) => r.content).join(''));
    (n.children || []).forEach(walk);
  })(payload.root);
  if (payload.captureReport.iframesPierced >= 1) {
    assert(texts.join(' ').includes('IFRAME DESIGN TEXT'), 'iframe text captured');
    console.log('✅ case 2 passed (iframe piercing)');
  } else {
    // Some environments seal srcdoc frames; then the block must be reported,
    // never silent — that reporting is the contract the popup relies on.
    assert(payload.captureReport.iframesBlocked >= 1, 'blocked iframe must be reported');
    console.log('✅ case 2 passed (iframe sealed here, but correctly reported)');
  }
}


async function selectedCase() {
  const dom = new JSDOM('<!doctype html><html><head><title>Selected Canvas</title></head><body data-rect="0,0,1000,500"></body></html>', {
    url: 'https://example.claudeusercontent.com/selected',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  window.Element.prototype.getBoundingClientRect = function () { return rectOf(this); };
  Object.defineProperty(window.HTMLElement.prototype, 'offsetWidth', {
    configurable: true, get() { return rectOf(this).width; },
  });
  window.Range.prototype.getBoundingClientRect = () =>
    ({ x: 0, y: 0, width: 120, height: 30, top: 0, left: 0, right: 120, bottom: 30 });
  window.Range.prototype.getClientRects = () => [window.Range.prototype.getBoundingClientRect()];

  let captured = null;
  window.chrome = {
    runtime: { sendMessage(msg) { if (msg && msg.type === 'capture-result') captured = msg.payload; } },
  };

  const card = (id, x, y) =>
    `<div data-rect="${x},${y},80,32">Card ${id}</div>`;
  const board = (label, x) => `
    <section data-label="${label}" data-rect="${x},0,400,340">
      <div class="canvas-label" data-rect="${x},0,400,40">${label} CANVAS LABEL</div>
      <main class="screen" data-rect="${x},40,400,300">
        <h1 data-rect="${x + 10},50,300,36">${label} INSIDE TITLE</h1>
        <p data-rect="${x + 10},96,300,24">${label} inside body</p>
        ${card(1, x + 10, 130)}${card(2, x + 110, 130)}${card(3, x + 210, 130)}
        ${card(4, x + 10, 180)}${card(5, x + 110, 180)}${card(6, x + 210, 180)}
      </main>
    </section>`;
  window.document.body.innerHTML = board('Alpha', 0) + board('Beta', 500);
  window.__CLAUDE2FIGMA_CAPTURE_OPTIONS__ = { scope: 'single', selectedIndexes: [1] };

  window.eval(injectSrc);
  for (let i = 0; i < 50 && !captured; i += 1) await new Promise((r) => setTimeout(r, 100));
  assert(captured && captured.ok, `selected capture should succeed: ${captured && captured.error || ''}`);
  const payload = JSON.parse(captured.json);
  const report = payload.captureReport;
  console.log('   selected report:', JSON.stringify(report));

  assert.strictEqual(payload.slideCount, 1, 'single mode captures one slide');
  assert.strictEqual(report.scope, 'single');
  assert.strictEqual(report.artboardsDetected, 2);
  assert.strictEqual(report.selectedArtboards, 1);
  assert(report.contentRootsStripped >= 1, 'outer artboard host should be stripped');
  assert.strictEqual(payload.root.role, 'slide');
  assert.strictEqual(payload.root.name, 'Beta');
  assert.strictEqual(Math.round(payload.root.rect.h), 300,
    'slide height is the inside screen, not 340px host + label');

  const texts = [];
  (function walk(n) {
    if (n.type === 'TEXT') texts.push((n.text.runs || []).map((r) => r.content).join(''));
    (n.children || []).forEach(walk);
  })(payload.root);
  const joined = texts.join(' | ');
  assert(joined.includes('Beta INSIDE TITLE'), 'selected Beta screen captured');
  assert(!joined.includes('Alpha INSIDE TITLE'), 'unselected Alpha screen skipped');
  assert(!joined.includes('CANVAS LABEL'), 'canvas label outside the screen skipped');
  console.log('✅ case 3 passed (single artboard + inside-screen root)');
}


async function visualCase() {
  const dom = new JSDOM('<!doctype html><html><head><title>Visual Canvas</title></head><body data-rect="0,0,1100,760"></body></html>', {
    url: 'https://example.claudeusercontent.com/visual-canvas',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  window.Element.prototype.getBoundingClientRect = function () { return rectOf(this); };
  Object.defineProperty(window.HTMLElement.prototype, 'offsetWidth', {
    configurable: true, get() { return rectOf(this).width; },
  });
  window.Range.prototype.getBoundingClientRect = () =>
    ({ x: 0, y: 0, width: 120, height: 30, top: 0, left: 0, right: 120, bottom: 30 });
  window.Range.prototype.getClientRects = () => [window.Range.prototype.getBoundingClientRect()];

  let captured = null;
  window.chrome = {
    runtime: { sendMessage(msg) { if (msg && msg.type === 'capture-result') captured = msg.payload; } },
  };

  const cards = (x, y) => Array.from({ length: 10 }, (_, i) =>
    `<div data-rect="${x + (i % 5) * 92},${y + Math.floor(i / 5) * 62},80,44">Card ${i + 1}</div>`).join('');
  const board = (label, title, x) => `
    <section class="board" data-rect="${x},0,520,360" style="background-color: rgb(17,17,17)">
      <div class="board-label" data-rect="${x},0,520,28">${label}</div>
      <div class="screen" data-rect="${x},28,520,332" style="background-color: rgb(34,34,34)">
        <h1 data-rect="${x + 16},44,360,36">${title}</h1>
        <p data-rect="${x + 16},90,420,24">Unlabelled visual screen content</p>
        ${cards(x + 16, 130)}
      </div>
    </section>`;
  window.document.body.innerHTML =
    '<main class="canvas-grid" data-rect="0,0,1100,760" style="display:grid;grid-template-columns:1fr 1fr">'
    + board('1 · Design canvas', 'Visual Home', 0)
    + board('2 · AI candidates', 'Visual Candidates', 560)
    + '</main>';

  window.eval(injectSrc);
  for (let i = 0; i < 50 && !captured; i += 1) await new Promise((r) => setTimeout(r, 100));
  assert(captured && captured.ok, `visual capture should succeed: ${captured && captured.error || ''}`);
  const payload = JSON.parse(captured.json);
  const report = payload.captureReport;
  console.log('   visual report:', JSON.stringify(report));
  assert.strictEqual(report.detectionMethod, 'visual');
  assert.strictEqual(report.mode, 'artboards');
  assert.strictEqual(payload.slideCount, 2);
  assert.deepStrictEqual(payload.root.children.map((c) => c.name),
    ['1 · Design canvas', '2 · AI candidates']);
  const texts = [];
  (function walk(n) {
    if (n.type === 'TEXT') texts.push((n.text.runs || []).map((r) => r.content).join(''));
    (n.children || []).forEach(walk);
  })(payload.root);
  assert(texts.join(' | ').includes('Visual Home'));
  assert(texts.join(' | ').includes('Visual Candidates'));
  console.log('✅ case 4 passed (unlabelled visual artboards)');
}

async function fidelityCase() {
  const dom = new JSDOM('<!doctype html><html><head><title>Fidelity Case</title></head><body data-rect="0,0,900,700"></body></html>', {
    url: 'https://example.claudeusercontent.com/fidelity',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  window.Element.prototype.getBoundingClientRect = function () { return rectOf(this); };
  Object.defineProperty(window.HTMLElement.prototype, 'offsetWidth', {
    configurable: true, get() { return rectOf(this).width; },
  });
  window.Range.prototype.getBoundingClientRect = () =>
    ({ x: 0, y: 0, width: 120, height: 30, top: 0, left: 0, right: 120, bottom: 30 });
  window.Range.prototype.getClientRects = () => [window.Range.prototype.getBoundingClientRect()];

  let captured = null;
  window.chrome = {
    runtime: { sendMessage(msg) { if (msg && msg.type === 'capture-result') captured = msg.payload; } },
  };
  window.document.body.innerHTML = `
    <main data-rect="0,0,900,700">
      <form data-rect="0,0,760,300">
        <label data-rect="0,0,360,80">Name
          <input id="name" data-rect="0,30,240,40" value="Initial" placeholder="Your name">
        </label>
        <label data-rect="380,0,360,80">Email
          <input id="email" data-rect="380,30,240,40" placeholder="Email placeholder">
        </label>
        <label data-rect="0,90,360,80">Password
          <input id="pass" type="password" data-rect="0,120,240,40" value="initial">
        </label>
        <label data-rect="380,90,360,80">Plan
          <select id="plan" data-rect="380,120,240,40">
            <option>Starter</option><option selected>Growth plan</option><option>Enterprise</option>
          </select>
        </label>
        <label data-rect="0,180,360,100">Notes
          <textarea id="notes" data-rect="0,210,300,60">Initial notes</textarea>
        </label>
        <label data-rect="380,180,220,40">
          <input id="check" type="checkbox" data-rect="380,190,16,16"> Checked option
        </label>
        <label data-rect="610,180,220,40">
          <input id="radio" type="radio" data-rect="610,190,16,16"> Radio chosen
        </label>
      </form>
      <table data-rect="0,320,420,110">
        <tr data-rect="0,320,420,50"><th data-rect="0,320,200,50">Metric</th><th data-rect="200,320,200,50">Value</th></tr>
        <tr data-rect="0,370,420,50"><td data-rect="0,370,200,50">Revenue</td><td data-rect="200,370,200,50">42</td></tr>
      </table>
      <video data-rect="0,450,320,180" poster="data:image/png;base64,iVBORw0KGgo="></video>
      <span data-rect="0,0,1,1" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)">Screen reader only text</span>
    </main>`;
  // Live properties, not the initial HTML attributes, are what a user sees.
  window.document.getElementById('name').value = 'Changed Person';
  window.document.getElementById('pass').value = 'abcdefghij';
  window.document.getElementById('plan').selectedIndex = 2;
  window.document.getElementById('notes').value = 'Live first\nLive second';
  window.document.getElementById('check').checked = true;
  window.document.getElementById('radio').checked = true;
  window.__CLAUDE2FIGMA_CAPTURE_OPTIONS__ = { scope: 'page' };

  window.eval(injectSrc);
  for (let i = 0; i < 50 && !captured; i += 1) await new Promise((r) => setTimeout(r, 100));
  assert(captured && captured.ok, `fidelity capture should succeed: ${captured && captured.error || ''}`);
  const payload = JSON.parse(captured.json);
  const nodes = [];
  const texts = [];
  (function walk(n) {
    nodes.push(n);
    if (n.type === 'TEXT') texts.push((n.text.runs || []).map((r) => r.content).join(''));
    (n.children || []).forEach(walk);
  })(payload.root);
  const joined = texts.join('|');

  for (const expected of [
    'Changed Person', 'Email placeholder', '••••••••••', 'Enterprise',
    'Live first\nLive second', '✓', '●', 'Metric', 'Value', 'Revenue', '42',
  ]) assert(texts.includes(expected), `expected exact text ${JSON.stringify(expected)}, got ${JSON.stringify(texts)}`);
  for (const forbidden of [
    'Initial', 'abcdefghij', 'Initial notes', 'Starter', 'Growth plan',
    'MetricValueRevenue42', 'Screen reader only text',
  ]) assert(!joined.includes(forbidden), `forbidden/merged text leaked: ${forbidden}`);
  assert(nodes.some((n) => n.type === 'IMAGE' && n.name === 'video'), 'video becomes an image/placeholder node');
  assert.strictEqual(payload.captureReport.videos, 1, 'video counted in report');
  console.log('✅ case 5 passed (live form values, table cells, video, sr-only)');
}

main()
  .then(iframeCase)
  .then(selectedCase)
  .then(visualCase)
  .then(fidelityCase)
  .catch((e) => { console.error('❌', e); process.exit(1); });
