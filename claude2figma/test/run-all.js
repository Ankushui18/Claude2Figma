#!/usr/bin/env node
// Run every headless test in this folder:
//   node test/run-all.js        (or: node claude2figma/test/run-all.js)
// Tests that need jsdom report themselves as skipped when it is not
// installed (npm i --no-save jsdom). Exit code 1 if anything fails.
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const tests = fs.readdirSync(__dirname)
  .filter((f) => f.endsWith('-test.js'))
  .sort();

const results = [];
for (const name of tests) {
  const res = spawnSync(process.execPath, [path.join(__dirname, name)], {
    encoding: 'utf8',
    timeout: 120000,
  });
  const out = `${res.stdout || ''}${res.stderr || ''}`;
  const skipped = /⏭️[^\n]*skipped/i.test(out);
  if (res.status !== 0) {
    results.push([name, 'FAIL', '']);
    console.log(`\n──── ${name} ────`);
    console.log(out.trim());
  } else if (skipped) {
    results.push([name, 'SKIP', 'jsdom not installed (npm i --no-save jsdom)']);
  } else {
    results.push([name, 'PASS', '']);
  }
}

const pad = Math.max(...results.map(([n]) => n.length));
for (const [name, status, note] of results) {
  console.log(`${status.padEnd(4)}  ${name.padEnd(pad)}${note ? '  — ' + note : ''}`);
}

const failed = results.filter(([, s]) => s === 'FAIL').length;
const skipped = results.filter(([, s]) => s === 'SKIP').length;
console.log(`\n${results.length} tests · ${results.length - failed - skipped} passed · ${skipped} skipped · ${failed} failed`);
process.exit(failed ? 1 : 0);
