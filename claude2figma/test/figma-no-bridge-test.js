// Architecture guard: Figma canvas copy is standalone inside the Figma
// plugin. The Chrome extension must not require (or contain) a connection
// bridge to Figma, and the plugin must not show an Enable/Connect step.
//   node test/figma-no-bridge-test.js
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const background = fs.readFileSync(path.join(root, 'extension', 'background.js'), 'utf8');
const popup = fs.readFileSync(path.join(root, 'extension', 'popup.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extension', 'manifest.json'), 'utf8'));
const pluginUi = fs.readFileSync(path.join(root, 'figma-plugin', 'ui.html'), 'utf8');

for (const [label, source] of [
  ['background', background],
  ['popup', popup],
  ['plugin UI', pluginUi],
]) {
  assert(!source.includes('Enable Chrome extension copy'), `${label} has no Enable step`);
  assert(!source.includes('claude2figmaBridge'), `${label} has no page bridge protocol`);
  assert(!source.includes('extensionBridge'), `${label} has no extension bridge state`);
}
assert(!background.includes('figmaBridgeRequestInPage'), 'background has no Figma-page relay');
assert(!background.includes('requestFigmaBridge'), 'background cannot request a Figma bridge');
assert(!background.includes('captureFigmaActiveTab'), 'background does not capture through Figma');
assert(!popup.includes('figma-capture-scope'), 'popup offers no Figma copy scopes');
assert(!popup.includes('Check plugin connection'), 'popup has no connection-check action');
assert(!pluginUi.includes('figma-bridge-btn'), 'plugin has no bridge button');
assert(!pluginUi.includes('figma-bridge-state'), 'plugin has no bridge status pill');

assert(Array.isArray(manifest.host_permissions)
  && !manifest.host_permissions.some((pattern) => String(pattern).includes('figma.com')),
'extension requests no Figma host permission');

// The standalone replacement must remain available in the plugin itself.
assert(pluginUi.includes('id="figma-export-btn"'), 'plugin keeps its own Copy canvas button');
assert(pluginUi.includes('id="figma-download-btn"'), 'plugin keeps direct .deck.json download');
assert(pluginUi.includes('no Chrome-extension connection'), 'plugin explains standalone copy');
assert(pluginUi.includes('different Figma login'), 'plugin explains account-independent files');
assert(background.includes("reason: 'figma-plugin-only'"), 'background identifies Figma as plugin-only');
assert(popup.includes('Copy this inside Figma'), 'popup directs users into the plugin');

console.log('✅ figma-no-bridge-test passed (standalone plugin copy; no Chrome↔Figma connection)');
