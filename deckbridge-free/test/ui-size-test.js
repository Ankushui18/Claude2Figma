// Plugin UI test (needs jsdom). Simulates pasting the sample JSON,
// confirms each artboard gets its own sizing row, then captures the
// message that would be sent to code.js when Import is clicked.
//   node test/ui-size-test.js
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

let JSDOM;
for (const candidate of ['jsdom', '/tmp/dbtest/node_modules/jsdom']) {
  try { ({ JSDOM } = require(candidate)); break; } catch (_) { /* next */ }
}
if (!JSDOM) {
  console.log('⏭️ ui-size-test skipped (jsdom not installed)');
  process.exit(0);
}

(async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'figma-plugin', 'ui.html'), 'utf8');
  const sample = fs.readFileSync(path.join(__dirname, '..', 'sample', 'sample-deck.deck.json'), 'utf8');
  const dom = new JSDOM(html, {
    url: 'https://www.figma.com/plugin/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const { document } = window;

  const posted = [];
  window.addEventListener('message', (e) => {
    if (e.data && e.data.pluginMessage) posted.push(e.data.pluginMessage);
  });

  document.getElementById('paste').value = sample;
  document.getElementById('paste-btn').click();

  assert(document.getElementById('screen-ready').classList.contains('active'), 'paste opens ready screen');
  const rows = document.querySelectorAll('.artboard-row');
  assert.strictEqual(rows.length, 2, 'one sizing row per artboard');
  assert.strictEqual(document.getElementById('per-artboard-wrap').hidden, false, 'individual controls visible');

  function fire(el, type = 'change') {
    el.dispatchEvent(new window.Event(type, { bubbles: true }));
  }

  // Popular import-size shortcuts are visible as soon as JSON is pasted.
  const quick1600 = document.querySelector('[data-size-preset="1600x900"]');
  assert(quick1600, '1600 × 900 shortcut is shown');
  quick1600.click();
  assert.strictEqual(document.getElementById('size-preset').value, '1600x900',
    '1600 shortcut sets the global import size');
  assert(quick1600.classList.contains('is-active'), '1600 shortcut is marked active');
  assert(rows[0].querySelector('.slide-target').textContent.includes('1600 × 900'),
    'artboards preview at 1600 × 900 after shortcut');

  // Global desktop size for everything first.
  const globalPreset = document.getElementById('size-preset');
  globalPreset.value = '1920x1080';
  fire(globalPreset);
  assert(rows[0].querySelector('.slide-target').textContent.includes('1920 × 1080'),
    'first artboard follows global size');
  assert.strictEqual(rows[0].querySelector('.slide-target-w').value, '1920',
    'visible target width follows the global setting');
  assert.strictEqual(rows[0].querySelector('.slide-target-h').value, '1080',
    'visible target height follows the global setting');

  // Typing an exact size overrides only that artboard and uses Fit inside,
  // so the resulting Figma frame is exactly the typed W x H.
  const firstW = rows[0].querySelector('.slide-target-w');
  const firstH = rows[0].querySelector('.slide-target-h');
  firstW.value = '1440'; fire(firstW, 'input');
  firstH.value = '900'; fire(firstH, 'input');
  assert.strictEqual(rows[0].querySelector('.slide-preset').value, 'custom',
    'typing a target size switches that row to custom');
  assert(rows[0].querySelector('.slide-target').textContent.includes('1440 × 900'),
    'first artboard uses its typed exact size');

  // Then override only artboard 2 to an exact phone frame.
  const secondPreset = rows[1].querySelector('.slide-preset');
  secondPreset.value = '390x844';
  fire(secondPreset);
  const secondFit = rows[1].querySelector('.slide-fit');
  secondFit.value = 'fit';
  fire(secondFit);
  assert(rows[1].querySelector('.slide-target').textContent.includes('390 × 844'),
    'second artboard uses phone override');
  assert.strictEqual(rows[1].querySelector('.slide-target-w').value, '390',
    'preset fills the visible target width');
  assert(rows[0].querySelector('.slide-target').textContent.includes('1440 × 900'),
    'first artboard still uses its typed size');

  // The same ready screen also chooses full vs selected import. Uncheck
  // artboard 2, verify the button/preview, then check it again for import.
  const secondEnabled = rows[1].querySelector('.slide-enabled');
  secondEnabled.checked = false; fire(secondEnabled);
  assert(document.getElementById('import-btn').textContent.includes('1 selected'),
    'unchecking an artboard changes import to selected mode');
  assert(rows[1].querySelector('.slide-target').textContent.includes('Not imported'),
    'unchecked artboard is marked as skipped');
  secondEnabled.checked = true; fire(secondEnabled);

  document.getElementById('import-btn').click();
  await new Promise((r) => setTimeout(r, 150));
  const msg = posted.find((m) => m.type === 'import');
  assert(msg, 'import click posts import message');
  assert.strictEqual(msg.options.targetW, 1920, 'global option sent');
  assert.strictEqual(msg.options.slides.length, 2, 'one resolved option per artboard');
  assert.strictEqual(msg.options.slides[0].targetW, 1440, 'typed first width sent');
  assert.strictEqual(msg.options.slides[0].targetH, 900, 'typed first height sent');
  assert.strictEqual(msg.options.slides[0].fit, 'fit', 'typed size uses exact-frame fit');
  assert.strictEqual(msg.options.slides[0].enabled, true, 'first artboard enabled');
  assert.strictEqual(msg.options.slides[1].targetW, 390, 'second override width sent');
  assert.strictEqual(msg.options.slides[1].targetH, 844, 'second override height sent');
  assert.strictEqual(msg.options.slides[1].fit, 'fit', 'second override fit sent');
  assert.strictEqual(msg.options.slides[1].enabled, true, 'second artboard re-enabled');

  console.log('✅ ui-size-test passed (paste → 1920/1600/1440/mobile shortcuts + exact per-artboard W×H)');
})().catch((e) => { console.error('❌', e); process.exit(1); });
