'use strict';
// GATE: editor_link.py names the right .gs file and links, refuses every
// request that can't be followed, and the manifest records every store's
// Sheet (a store added without one fails here, which is the reminder).
//
// Run bare: node tests/editor_link.test.js
// A passing run ends with "editor_link: ALL PASS".

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const SCRIPT = path.join(REPO, 'editor_link.py');
const APPS = path.join(REPO, 'apps-script');
const PY = process.env.PYTHON || 'python';
const targets = JSON.parse(fs.readFileSync(path.join(APPS, '.clasp-targets.json'), 'utf8'));
const bySlug = Object.fromEntries(targets.map(t => [t.slug, t]));

function run(script, args, appsDir) {
  const r = spawnSync(PY, [script].concat(args), {
    encoding: 'utf8', env: Object.assign({}, process.env, { MOG_APPS_DIR: appsDir || APPS })
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

// A throwaway apps folder where two files declare the same function.
const dupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mog-editor-link-'));
fs.writeFileSync(path.join(dupDir, 'A.gs'), 'function dupFn() {}\n');
fs.writeFileSync(path.join(dupDir, 'B.gs'), '// function dupFn( in a comment must not count\nfunction dupFn() {}\n');
fs.writeFileSync(path.join(dupDir, '.clasp-targets.json'), JSON.stringify([{ slug: 'x', label: 'X', scriptId: 'S' }]));

const CHECKS = {
  'names Sync.gs and rprfo\'s editor + Sheet links for test_supabaseParity': s => {
    const r = run(s, ['test_supabaseParity', 'rprfo']);
    const t = bySlug.rprfo;
    return r.code === 0 && r.out.includes('**`Sync.gs`**') &&
      r.out.includes('https://script.google.com/d/' + t.scriptId + '/edit') &&
      !!t.sheet && r.out.includes('https://docs.google.com/spreadsheets/d/' + t.sheet.id + '/edit');
  },
  'names Admin.gs for setupMobileApi': s => {
    const r = run(s, ['setupMobileApi', 'rpr']);
    return r.code === 0 && r.out.includes('**`Admin.gs`**');
  },
  '"all" prints one block per store, and every store has its Sheet recorded': s => {
    const r = run(s, ['test_supabaseParity', 'all']);
    const blocks = (r.out.match(/^Run \*\*/gm) || []).length;
    return r.code === 0 && blocks === targets.length && !r.out.includes('not recorded');
  },
  'refuses a name ending in "_" (hidden from the Run menu)': s => {
    const r = run(s, ['computeSuggestedQty_', 'rprfo']);
    return r.code === 1 && r.out.includes('Run menu');
  },
  'refuses a name no .gs declares': s => run(s, ['noSuchFunctionXyz', 'rprfo']).code === 1,
  'refuses a request with no store': s => {
    const r = run(s, ['test_supabaseParity']);
    return r.code === 1 && r.out.includes('which store');
  },
  'refuses an unknown store': s => run(s, ['test_supabaseParity', 'nosuchstore']).code === 1,
  'refuses a name declared in two .gs files': s => {
    const r = run(s, ['dupFn', 'x'], dupDir);
    return r.code === 1 && r.out.includes('A.gs and B.gs');
  }
};

let failed = 0;
for (const [name, check] of Object.entries(CHECKS)) {
  let okay = false;
  try { okay = check(SCRIPT); } catch (e) { okay = false; }
  if (okay) console.log('PASS  ' + name);
  else { failed++; console.log('FAIL  ' + name); }
}

// Controls: each planted defect must make its check fail.
const src = fs.readFileSync(SCRIPT, 'utf8');
const plantDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mog-editor-link-plant-'));
const CONTROLS = [
  ['underscore refusal removed', "    if fn.endswith('_'):", "    if False:", 'refuses a name ending in "_" (hidden from the Run menu)'],
  ['duplicate refusal removed', '    if len(hits) > 1:', '    if False:', 'refuses a name declared in two .gs files'],
  ['store requirement removed', '    if not slugs:', '    if False:', 'refuses a request with no store'],
  ['editor link built from the wrong id', "% (target['scriptId'], gs_file, fn)", "% (target['deploymentId'], gs_file, fn)",
    'names Sync.gs and rprfo\'s editor + Sheet links for test_supabaseParity']
];
for (const [name, find, replace, checkName] of CONTROLS) {
  const first = src.indexOf(find);
  if (first < 0 || src.indexOf(find, first + 1) >= 0) {
    failed++; console.log(`FAIL  control "${name}": anchor missing or not unique`); continue;
  }
  let baseline = false;
  try { baseline = CHECKS[checkName](SCRIPT); } catch (e) { baseline = false; }
  if (!baseline) {
    failed++; console.log(`FAIL  control "${name}": its check already fails on the real script, so it proves nothing`); continue;
  }
  const planted = path.join(plantDir, 'editor_link.py');
  fs.writeFileSync(planted, src.slice(0, first) + replace + src.slice(first + find.length));
  let stillPasses;
  try { stillPasses = CHECKS[checkName](planted); } catch (e) { stillPasses = false; }
  if (!stillPasses) console.log(`PASS  control "${name}" bites`);
  else { failed++; console.log(`FAIL  control "${name}" did NOT bite`); }
}

console.log(failed ? `editor_link: ${failed} FAILED` : 'editor_link: ALL PASS');
process.exit(failed ? 1 : 0);
