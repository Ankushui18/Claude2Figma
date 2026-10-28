#!/usr/bin/env node
// Rebuild the Chrome extension icons from the master logo:
//   npm run icons     (needs: npm install — dev dependency @resvg/resvg-js)
// Writes extension/icons/icon-{16,32,48,128}.png
'use strict';

const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');

const svgPath = path.join(__dirname, 'logo.svg');
const outDir = path.join(__dirname, '..', 'extension', 'icons');
const svg = fs.readFileSync(svgPath, 'utf8');

for (const size of [16, 32, 48, 128]) {
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: size } });
  const file = path.join(outDir, `icon-${size}.png`);
  fs.writeFileSync(file, resvg.render().asPng());
  console.log(`✓ ${path.relative(process.cwd(), file)}`);
}
console.log('Icons rebuilt from brand/logo.svg');
