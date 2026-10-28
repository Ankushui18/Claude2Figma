// Background frame-selection test: the worker must probe every frame and
// choose the actual design document (with artboards), not frame 0 just
// because it is the Claude editor shell.
//   node test/background-frame-test.js
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const listeners = [];
let capturedFrameId = null;
let activeTab = { id: 7, title: 'Varis Studio Design', url: 'https://claude.ai/design/p/varis' };

const artboards = [
  { index: 0, name: '1 · Design canvas', w: 1280, h: 800 },
  { index: 1, name: '2 · Motion lab', w: 1280, h: 800 },
  { index: 2, name: '3 · AI candidates', w: 1280, h: 800 },
  { index: 3, name: '4 · Template editor', w: 1280, h: 800 },
];

const chrome = {
  runtime: {
    onMessage: { addListener(fn) { listeners.push(fn); } },
  },
  tabs: {
    async query() {
      return [activeTab];
    },
  },
  webNavigation: {
    async getAllFrames() {
      return [
        { frameId: 0, url: 'https://claude.ai/design/p/varis' },
        { frameId: 11, url: 'https://tracking.example/shim' },
        { frameId: 22, url: 'https://preview.claudeusercontent.com/varis/canvas' },
      ];
    },
  },
  scripting: {
    async executeScript(options) {
      const frameId = options.target.frameIds[0];
      if (options.files) {
        capturedFrameId = frameId;
        setTimeout(() => {
          listeners[0]({
            type: 'capture-result',
            payload: { ok: true, json: '{"slideCount":1}', title: 'AI candidates' },
          });
        }, 0);
        return [{}];
      }
      if (options.args && typeof options.args[0] === 'string') {
        return [{}]; // Claude capture-options setter; there is no Figma bridge injection.
      }
      if (frameId === 0) {
        return [{
          result: {
            formato: 'pagina-unica', slides: 1, artboards: [],
            detection: 'page', metrics: { elements: 9000 },
          },
        }];
      }
      if (frameId === 11) throw new Error('cannot access shim frame');
      if (frameId === 22) {
        return [{
          result: {
            formato: 'artboards', slides: 4, artboards,
            rotulos: artboards.map((a) => a.name),
            detection: 'visual', metrics: { elements: 1200 },
          },
        }];
      }
      return [{ result: { formato: 'vazio', slides: 0, artboards: [] } }];
    },
  },
};

const sandbox = { chrome, console, setTimeout, clearTimeout, URL };
vm.createContext(sandbox);
vm.runInContext(
  fs.readFileSync(path.join(__dirname, '..', 'extension', 'background.js'), 'utf8'),
  sandbox,
);

const handler = listeners[listeners.length - 1];
assert(typeof handler === 'function', 'background message handler registered');

function send(message) {
  return new Promise((resolve) => handler(message, {}, resolve));
}

(async () => {
  const probe = await send({ type: 'probe' });
  assert.strictEqual(probe.ok, true);
  assert.strictEqual(probe.frameId, 22, 'design frame wins over editor shell');
  assert.strictEqual(probe.slides, 4);
  assert.strictEqual(probe.detection, 'visual');
  assert.deepStrictEqual(probe.artboards.map((a) => a.name), artboards.map((a) => a.name));

  const capture = await send({
    type: 'capture',
    options: { scope: 'single', selectedIndexes: [2] },
  });
  assert.strictEqual(capture.ok, true);
  assert.strictEqual(capturedFrameId, 22, 'capture injects into the same design frame');

  activeTab = {
    id: 8, title: 'Varis Studio – Figma',
    url: 'https://www.figma.com/design/abc123/Varis-Studio?node-id=1-2',
  };
  const figmaProbe = await send({ type: 'probe' });
  assert.strictEqual(figmaProbe.ok, false, 'Chrome popup does not offer Figma canvas capture');
  assert.strictEqual(figmaProbe.reason, 'figma-plugin-only');
  assert.strictEqual(figmaProbe.isFigma, true, 'Figma editor tab is recognized only for guidance');
  assert.strictEqual(figmaProbe.detection, 'figma-plugin-only');
  assert.strictEqual(figmaProbe.bridge, undefined, 'no bridge state is returned');

  const figmaCapture = await send({ type: 'capture', options: { scope: 'full' } });
  assert.strictEqual(figmaCapture.ok, false, 'extension does not scrape or connect to Figma');
  assert(figmaCapture.error.includes('inside the DeckBridge Figma plugin'),
    'capture directs the user to the standalone plugin flow');
  assert(figmaCapture.error.includes('any Figma browser or desktop login'),
    'capture explains the exported file is account-independent');
  assert.strictEqual(capturedFrameId, 22, 'Figma guidance does not inject the web serializer');

  console.log('✅ background-frame-test passed (Claude frame ranking + Figma is plugin-only)');
})().catch((e) => { console.error('❌', e); process.exit(1); });
