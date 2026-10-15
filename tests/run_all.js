'use strict';
// Runs every gate in tests/: each *.test.js, plus the slicer's own self-test.
// Registration is by existence, so there's no list to forget to update. Any
// OTHER .js here must be a helper named in HELPERS with its reason; a new
// script that is neither fails the run, so nothing can sit here unrun.
//
// Run from anywhere: node tests/run_all.js
// A passing run ends with "run_all: ALL PASS (N gates)".

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const HELPERS = {
  'run_all.js': 'this runner',
  'slice_js.js': 'library: slices one function out of .gs source',
  'fake_apps_script.js': 'library: fake Sheets/services + loaders',
  'mog_fixture.js': 'library: seeded randomized stores'
};

const dir = __dirname;
const files = fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort();
const gates = files.filter(f => f.endsWith('.test.js') || f === 'slice_js_selftest.js');
const strays = files.filter(f => !gates.includes(f) && !HELPERS[f]);

let failed = 0;
for (const g of gates) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(dir, g)], { encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  const last = out.trim().split('\n').pop();
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (r.status === 0) {
    console.log(`PASS  ${g} (${secs}s): ${last}`);
  } else {
    failed++;
    console.log(`FAIL  ${g} (${secs}s, exit ${r.status}):`);
    console.log(out.split('\n').filter(l => /FAIL|Error|at /.test(l)).slice(0, 20).map(l => '      ' + l).join('\n'));
  }
}
for (const s of strays) {
  failed++;
  console.log(`FAIL  ${s} is neither a gate (*.test.js) nor a listed helper: make it a gate or list it in HELPERS`);
}

console.log(failed ? `run_all: ${failed} FAILED` : `run_all: ALL PASS (${gates.length} gates)`);
process.exit(failed ? 1 : 0);
