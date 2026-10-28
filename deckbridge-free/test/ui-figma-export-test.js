// Figma-copy UI test: switch to "Copy Figma canvas", render the frame
// checklist, request only the checked frames, then send the exported JSON
// into the existing import/resize screen.
//   node test/ui-figma-export-test.js
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

let JSDOM;
for (const candidate of ['jsdom', '/tmp/dbtest/node_modules/jsdom']) {
  try { ({ JSDOM } = require(candidate)); break; } catch (_) { /* next */ }
}
if (!JSDOM) {
  console.log('⏭️ ui-figma-export-test skipped (jsdom not installed — run: npm i --no-save jsdom)');
  process.exit(0);
}

const html = fs.readFileSync(path.join(__dirname, '..', 'figma-plugin', 'ui.html'), 'utf8');
const sample = fs.readFileSync(path.join(__dirname, '..', 'sample', 'sample-deck.deck.json'), 'utf8');
const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://localhost/' });
const { window } = dom;
const doc = window.document;
const sent = [];
window.addEventListener('message', (e) => {
  if (e.data && e.data.pluginMessage) sent.push(e.data.pluginMessage);
});
const tick = () => new Promise((r) => setTimeout(r, 10));
const $ = (id) => doc.getElementById(id);
const change = (el) => el.dispatchEvent(new window.Event('change', { bubbles: true }));
const fromPlugin = (pluginMessage) => {
  window.dispatchEvent(new window.MessageEvent('message', { data: { pluginMessage } }));
};

(async () => {
  $('mode-export').click();
  await tick();
  assert($('screen-export-figma').classList.contains('active'), 'export screen opens');
  assert(sent.some((m) => m.type === 'get-figma-canvas'), 'canvas listing requested');

  fromPlugin({
    type: 'figma-canvas',
    fileName: 'Varis Studio',
    currentPageId: 'page-1',
    selection: [{ id: 'frame-a', name: 'Desktop Home', type: 'FRAME', w: 1280, h: 720, pageId: 'page-1' }],
    pages: [
      { id: 'page-1', name: 'Core', frames: [
        { id: 'frame-a', name: 'Desktop Home', type: 'FRAME', w: 1280, h: 720, pageId: 'page-1' },
        { id: 'frame-b', name: 'Mobile Home', type: 'FRAME', w: 390, h: 844, pageId: 'page-1' },
      ] },
      { id: 'page-2', name: 'More', frames: [
        { id: 'frame-c', name: 'Settings', type: 'FRAME', w: 1024, h: 768, pageId: 'page-2' },
      ] },
    ],
  });
  await tick();
  const selection = doc.querySelector('input[name="figma-export-scope"][value="selection"]');
  selection.checked = true;
  change(selection);
  assert($('figma-export-btn').textContent.includes('current selection (1)'), 'selection scope enabled');

  const checklist = doc.querySelector('input[name="figma-export-scope"][value="checklist"]');
  checklist.checked = true;
  change(checklist);
  let boxes = [...doc.querySelectorAll('.figma-frame-check')];
  assert.strictEqual(boxes.length, 3, 'all frames listed');
  assert.strictEqual(boxes.filter((b) => b.checked).length, 2, 'current page frames default checked');

  boxes.find((b) => b.dataset.frameId === 'frame-a').checked = false;
  change(boxes[0]);
  assert($('figma-export-btn').textContent.includes('1 checked frame'), 'unchecked frame removed');
  $('figma-export-btn').click();
  await tick();
  const request = sent.filter((m) => m.type === 'export-figma-canvas').pop();
  assert(request, 'export request posted');
  assert.strictEqual(request.options.scope, 'checklist');
  assert.strictEqual(request.options.frameIds.join('|'), 'frame-b');

  fromPlugin({ type: 'figma-export-status', message: 'Copying 1 of 1: Mobile Home…' });
  fromPlugin({
    type: 'figma-export', json: sample, filename: 'varis-studio.deck.json',
    slides: 2, nodes: 18, frames: [{ name: 'Welcome', width: 1280, height: 720 }, { name: 'Details', width: 1280, height: 720 }],
  });
  await tick();
  assert.strictEqual($('figma-export-result').hidden, false, 'copy result shown');
  assert($('figma-import-copy-btn'), 'import-copy action present');

  $('figma-import-copy-btn').click();
  await tick();
  assert($('screen-ready').classList.contains('active'), 'copied JSON opens import/resize screen');
  assert.strictEqual(doc.querySelectorAll('.artboard-row').length, 2, 'resize list gets exported artboards');

  // There is deliberately no Chrome-extension bridge/connect step. A
  // bridge-shaped page message must be ignored completely: Figma canvas
  // copy starts only from this plugin's own Copy canvas button.
  assert.strictEqual($('figma-bridge-btn'), null, 'no Enable/Connect bridge button');
  assert.strictEqual($('figma-bridge-state'), null, 'no bridge status UI');
  const bridgeResponses = [];
  const fakePageWindow = {
    postMessage(message, origin) { bridgeResponses.push({ message, origin }); },
  };
  const sentBefore = sent.length;
  window.dispatchEvent(new window.MessageEvent('message', {
    data: {
      deckbridgeBridge: '1', type: 'export', requestId: 'must-be-ignored',
      options: { scope: 'checklist', frameIds: ['frame-c'] },
    },
    origin: 'https://www.figma.com', source: fakePageWindow,
  }));
  await tick();
  assert.strictEqual(bridgeResponses.length, 0, 'no bridge response is sent');
  assert.strictEqual(sent.length, sentBefore, 'bridge-shaped message does not start an export');

  console.log('✅ ui-figma-export-test passed (standalone plugin export; no Chrome bridge)');
  window.close();
})().catch((e) => { console.error('❌', e); process.exit(1); });
