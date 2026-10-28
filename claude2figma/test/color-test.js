// Color parser test: loads the real plugin code.js in a vm with a stub
// figma global, then exercises parseColor() incl. oklch/lab/color-mix —
// the formats Chrome returns for modern Claude designs.
//   node test/color-test.js
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
  notify() {},
};
const sandbox = { figma, __html__: '', console };
vm.createContext(sandbox);
vm.runInContext(
  fs.readFileSync(path.join(__dirname, '..', 'figma-plugin', 'code.js'), 'utf8'),
  sandbox);

const parse = (s) => {
  sandbox.__input = s;
  return vm.runInContext('parseColor(__input)', sandbox);
};
const near = (actual, expected, eps, label) => {
  assert(actual, `${label}: got null`);
  for (const ch of ['r', 'g', 'b', 'a']) {
    assert(
      Math.abs(actual[ch] - expected[ch]) <= eps,
      `${label}: channel ${ch} expected ~${expected[ch]}, got ${actual[ch]}`);
  }
};

// classic formats
near(parse('rgb(255, 0, 0)'), { r: 1, g: 0, b: 0, a: 1 }, 0.01, 'rgb');
near(parse('rgba(0, 0, 0, 0.5)'), { r: 0, g: 0, b: 0, a: 0.5 }, 0.01, 'rgba');
near(parse('#8b5cf6'), { r: 0.545, g: 0.361, b: 0.965, a: 1 }, 0.01, 'hex');
near(parse('transparent'), { r: 0, g: 0, b: 0, a: 0 }, 0.01, 'transparent');
near(parse('hsl(240 100% 50%)'), { r: 0, g: 0, b: 1, a: 1 }, 0.01, 'hsl');

// oklch: known reference values (from oklch spec examples)
near(parse('oklch(1 0 0)'), { r: 1, g: 1, b: 1, a: 1 }, 0.01, 'oklch white');
near(parse('oklch(0 0 0)'), { r: 0, g: 0, b: 0, a: 1 }, 0.01, 'oklch black');
// oklch(0.628 0.258 29.2) ≈ #ff0000-ish red
near(parse('oklch(0.628 0.258 29.2)'), { r: 1, g: 0, b: 0, a: 1 }, 0.08, 'oklch red');
// dark blue-grey background like Claude canvas artboards use
const dark = parse('oklch(0.21 0.03 264)');
assert(dark && dark.r < 0.15 && dark.g < 0.18 && dark.b > dark.r && dark.b < 0.35,
  `oklch dark bg should be dark bluish, got ${JSON.stringify(dark)}`);
// alpha + percent lightness forms
near(parse('oklch(60% 0.15 240 / 50%)'), parse('oklch(0.6 0.15 240 / 0.5)'), 0.001, 'oklch % forms equal');
assert(Math.abs(parse('oklch(60% 0.15 240 / 50%)').a - 0.5) < 0.01, 'oklch alpha');

// oklab + lab + lch round-trips on white/black
near(parse('oklab(1 0 0)'), { r: 1, g: 1, b: 1, a: 1 }, 0.01, 'oklab white');
near(parse('lab(100% 0 0)'), { r: 1, g: 1, b: 1, a: 1 }, 0.02, 'lab white');
near(parse('lab(0% 0 0)'), { r: 0, g: 0, b: 0, a: 1 }, 0.02, 'lab black');
near(parse('lch(50% 0 0)'), { r: 0.466, g: 0.466, b: 0.466, a: 1 }, 0.06, 'lch mid grey');

// hwb + color() + color-mix
near(parse('hwb(0 0% 0%)'), { r: 1, g: 0, b: 0, a: 1 }, 0.01, 'hwb red');
near(parse('color(display-p3 1 0 0)'), { r: 1, g: 0, b: 0, a: 1 }, 0.01, 'display-p3 approx');
near(parse('color-mix(in srgb, rgb(255, 0, 0) 50%, rgb(0, 0, 255) 50%)'),
  { r: 0.5, g: 0, b: 0.5, a: 1 }, 0.02, 'color-mix 50/50');
near(parse('color-mix(in oklab, oklch(0.5 0.1 240) 25%, white)'),
  (() => { const c = parse('oklch(0.5 0.1 240)'); return { r: c.r * 0.25 + 0.75, g: c.g * 0.25 + 0.75, b: c.b * 0.25 + 0.75, a: 1 }; })(),
  0.02, 'color-mix with implied 75%');

assert.strictEqual(parse('not-a-color'), null);
assert.strictEqual(parse(''), null);
assert.strictEqual(parse(null), null);

console.log('✅ color-test passed (rgb/hex/hsl/hwb/oklch/oklab/lab/lch/color-mix/display-p3)');
