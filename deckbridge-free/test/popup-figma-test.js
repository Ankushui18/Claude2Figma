// Chrome popup on a Figma tab: DeckBridge must not offer a Chrome↔Figma
// connection or extension-driven Figma copy. It should direct the user to
// the standalone Copy Figma canvas flow inside the Figma plugin, whose
// .deck.json can be imported under any browser/desktop Figma login.
//   node test/popup-figma-test.js
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

let JSDOM;
for (const candidate of ['jsdom', '/tmp/dbtest/node_modules/jsdom']) {
  try { ({ JSDOM } = require(candidate)); break; } catch (_) { /* next */ }
}
if (!JSDOM) {
  console.log('⏭️ popup-figma-test skipped (jsdom not installed)');
  process.exit(0);
}

(async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'extension', 'popup.html'), 'utf8');
  const popupJs = fs.readFileSync(path.join(__dirname, '..', 'extension', 'popup.js'), 'utf8');
  const dom = new JSDOM(html, {
    url: 'chrome-extension://deckbridge/popup.html',
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
            ok: false,
            reason: 'figma-plugin-only',
            detection: 'figma-plugin-only',
            isFigma: true,
            title: 'Varis Studio – Figma',
          });
          return;
        }
        callback({ ok: false, error: 'capture should not be sent for a Figma tab' });
      },
      onMessage: { addListener() {} },
    },
    tabs: { create() {} },
    downloads: { download() {} },
  };

  window.eval(popupJs);
  await new Promise((r) => setTimeout(r, 100));

  const home = document.querySelector('[data-screen="home"]');
  assert(home.textContent.includes('Copy this inside Figma'), 'plugin-only heading shown');
  assert(home.textContent.includes('does not connect to Figma'), 'no connection is promised/required');
  assert(home.textContent.includes('any other Figma login'), 'different-login file flow explained');
  assert.strictEqual(document.getElementById('home-capture'), null, 'no Figma capture button in Chrome');
  assert.strictEqual(document.getElementById('home-figma-check'), null, 'no connection-check button');
  assert.strictEqual(document.querySelectorAll('input[name="figma-capture-scope"]').length, 0,
    'no Figma scopes are offered in Chrome');
  assert.strictEqual(document.querySelectorAll('[data-figma-frame-id]').length, 0,
    'no Figma frame checklist is offered in Chrome');
  assert(!sent.some((m) => m.type === 'capture'), 'no capture message is sent');

  document.getElementById('home-figma-howto').click();
  await new Promise((r) => setTimeout(r, 20));
  const howTo = document.querySelector('[data-screen="how-to"]');
  assert(howTo.classList.contains('is-active'), 'Figma instructions open');
  assert(howTo.textContent.includes('inside the plugin'), 'standalone plugin workflow shown');
  assert(howTo.textContent.includes('No Chrome-extension connection or matching Figma login is needed'));
  assert(!howTo.textContent.includes('Enable Chrome extension copy'), 'enable step is gone');

  console.log('✅ popup-figma-test passed (Figma is plugin-only; no Chrome connection)');
  window.close();
})().catch((e) => { console.error('❌', e); process.exit(1); });
