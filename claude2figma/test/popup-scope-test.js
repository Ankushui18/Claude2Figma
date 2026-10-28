// Extension popup scope test (needs jsdom). Verifies that the Chrome popup
// lists canvas artboards, lets the user choose selected-only capture, and
// sends those indexes to the background worker.
//   node test/popup-scope-test.js
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

let JSDOM;
for (const candidate of ['jsdom', '/tmp/dbtest/node_modules/jsdom']) {
  try { ({ JSDOM } = require(candidate)); break; } catch (_) { /* next */ }
}
if (!JSDOM) {
  console.log('⏭️ popup-scope-test skipped (jsdom not installed)');
  process.exit(0);
}

(async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'extension', 'popup.html'), 'utf8');
  const popupJs = fs.readFileSync(path.join(__dirname, '..', 'extension', 'popup.js'), 'utf8');
  const dom = new JSDOM(html, {
    url: 'chrome-extension://claude2figma/popup.html',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const { document } = window;
  const sent = [];
  const storage = {};

  window.chrome = {
    storage: {
      local: {
        async get(key) { return { [key]: storage[key] }; },
        async set(values) { Object.assign(storage, values); },
      },
    },
    runtime: {
      lastError: null,
      sendMessage(msg, callback) {
        sent.push(msg);
        if (msg.type === 'probe') {
          callback({
            ok: true,
            title: 'Product Canvas',
            formato: 'artboards',
            slides: 3,
            rotulos: ['Desktop', 'Mobile', 'Tablet'],
            artboards: [
              { index: 0, name: 'Desktop', w: 1440, h: 900 },
              { index: 1, name: 'Mobile', w: 390, h: 844 },
              { index: 2, name: 'Tablet', w: 834, h: 1194 },
            ],
          });
          return;
        }
        if (msg.type === 'capture') {
          callback({
            ok: true,
            title: 'Product Canvas',
            json: JSON.stringify({
              schema: 'claude2figma', schemaVersion: 1, title: 'Product Canvas', slideCount: 1,
              captureReport: {
                nodes: 42, layersRemoved: 7, inferredAutoLayouts: 2,
                scope: 'single', artboardsDetected: 3,
              },
              root: { type: 'FRAME', role: 'slide', rect: { x: 0, y: 0, w: 390, h: 844 }, children: [] },
            }),
          });
          return;
        }
        callback({ ok: false });
      },
      onMessage: { addListener() {} },
    },
    tabs: { create() {} },
    downloads: { download() {} },
  };

  window.eval(popupJs);
  await new Promise((r) => setTimeout(r, 100));

  const radios = document.querySelectorAll('input[name="capture-scope"]');
  assert.strictEqual(radios.length, 4, 'full/selected/single/whole-page scope choices are shown');
  assert.strictEqual(document.querySelectorAll('[data-artboard-index]').length, 3,
    'one checkbox per detected artboard');
  assert.strictEqual(document.getElementById('artboard-picker').hidden, true,
    'picker starts hidden in full-canvas mode');
  assert(document.getElementById('home-capture').textContent.includes('Capture full canvas (3)'));

  document.querySelector('input[name="capture-scope"][value="selected"]').click();
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(document.getElementById('artboard-picker').hidden, false,
    'selected mode reveals the artboard checklist');

  // In Selected mode, keep Desktop + Tablet and verify multi-select state.
  document.querySelector('[data-artboard-index="1"]').click();
  assert(document.getElementById('home-capture').textContent.includes('Capture 2 selected artboards'));
  assert.strictEqual(document.getElementById('scope-count').textContent, '2 selected');

  // Whole-page is the escape hatch when detection has mistaken a panel for
  // an artboard: the split is ignored and the frame is captured as one page.
  document.querySelector('input[name="capture-scope"][value="page"]').click();
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(document.getElementById('artboard-picker').hidden, true,
    'whole-page mode hides the artboard checklist');
  assert.strictEqual(document.getElementById('scope-count').textContent, 'Whole page');
  assert(document.getElementById('home-capture').textContent.includes('Capture whole page as one frame'));

  // Single mode is a separate product choice: checklist becomes a radio list
  // and exactly one artboard (Mobile) can be chosen.
  document.querySelector('input[name="capture-scope"][value="single"]').click();
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(document.querySelectorAll('input[name="single-artboard"]').length, 3,
    'single mode shows one radio per artboard');
  assert.strictEqual(document.querySelectorAll('[data-artboard-index]').length, 0,
    'single mode does not show multi-select checkboxes');
  document.querySelector('input[name="single-artboard"][value="1"]').click();
  assert(document.getElementById('home-capture').textContent.includes('Capture only “Mobile”'));
  assert.strictEqual(document.getElementById('scope-count').textContent, 'Single artboard');

  document.getElementById('home-capture').click();
  await new Promise((r) => setTimeout(r, 100));
  const capture = sent.find((m) => m.type === 'capture');
  assert(capture, 'capture message was sent');
  assert.strictEqual(capture.options.scope, 'single');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(capture.options.selectedIndexes)), [1]);
  assert(/^capture-\d+-[a-z0-9]+$/.test(capture.options.captureId),
    'capture carries a stable ID so a closed popup cannot lose/swap the result');
  assert.strictEqual(capture.options.entryTitle, 'Mobile');
  const success = document.querySelector('[data-screen="success"]');
  assert(success.classList.contains('is-active'), 'capture reaches success screen');
  assert(success.textContent.includes('Mobile'), 'single artboard name is used for the file');
  assert(success.textContent.includes('single artboard only'), 'success reports single scope');
  assert(success.textContent.includes('7 unnecessary wrappers removed'), 'success reports cleanup');

  console.log('✅ popup-scope-test passed (Full canvas / Selected artboards / Single artboard / Whole page)');
})().catch((e) => { console.error('❌', e); process.exit(1); });
