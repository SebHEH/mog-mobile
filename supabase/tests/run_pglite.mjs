// Runs MOG's schema files and smoke tests in PGlite (Postgres in Node), a
// stand-in for the Supabase SQL Editor: CI runs it on every push (gates.yml),
// and a maintainer runs it before taking a new schema file to the SQL Editor
// (skill mog-supabase-schema, ship order step 1).
//
//   npm ci                                   (once; the gates in tests/ need no install)
//   node supabase/tests/run_pglite.mjs       the whole chain, every smoke file, then the
//                                            newest schema file and its smoke again (re-run safe)
//   node supabase/tests/run_pglite.mjs smoke_v13.sql    the chain, then only these smoke files
//   SHOW=1 ...                               every smoke row, not just the failures
//
// The chain is schema.sql, then schema_v2.sql, schema_v3.sql ... in number
// order: every one there, so a new file is picked up without an edit here.
// A smoke file passes when every row of its last result says PASS.
// A passing run ends with "run_pglite: ALL PASS".
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SUPA = path.join(DIR, '..');

// Smoke files PGlite can't pass, with why. Each still runs in the Supabase
// SQL Editor after its schema file, as it did when it shipped.
const LOCAL_FAIL = {
  'smoke.sql': 'its v1 assertions were changed on purpose by schema_v3 (phone_direct)',
  'smoke_v2.sql': 'its v1 assertions were changed on purpose by schema_v3 (phone_direct)',
  'smoke_v4.sql': 'PGlite has no ICU: und-x-icu is faked as "C", so the vendor sort differs'
};
// Single rows PGlite can't pass, by check name; the rest of the file must.
const LOCAL_FAIL_ROWS = {
  'smoke_v7.sql': {
    why: 'in PGlite the check doesn\'t see what prepare_test_store wrote in that same statement (the call itself answers "phones on"); both passed in the SQL Editor',
    rows: ['test store: prepare gives it a cycle and turns its phones on', 'stores: zztest7\'s today edits never reach another store']
  }
};

const num = f => (f === 'schema.sql' ? 1 : Number((/^schema_v(\d+)\.sql$/.exec(f) || [])[1]));
const chain = fs.readdirSync(SUPA).filter(f => f === 'schema.sql' || /^schema_v\d+\.sql$/.test(f)).sort((a, b) => num(a) - num(b));
const smokeNum = f => (f === 'smoke.sql' ? 1 : Number((/^smoke_v(\d+)\.sql$/.exec(f) || [])[1]));
const allSmokes = fs.readdirSync(DIR).filter(f => f === 'smoke.sql' || /^smoke_v\d+\.sql$/.test(f)).sort((a, b) => smokeNum(a) - smokeNum(b));
const asked = process.argv.slice(2);
const smokes = asked.length ? asked : allSmokes;

let failed = 0;
const db = new PGlite({ extensions: { pgcrypto } });

async function run(name, sql) {
  try {
    return await db.exec(sql);
  } catch (e) {
    failed++;
    console.log('FAIL  ' + name + ': ' + e.message + (e.position ? ' (at ' + e.position + ')' : ''));
    if (e.position) {
      const p = Number(e.position);
      console.log('      ...' + sql.slice(Math.max(0, p - 200), p) + ' <<<HERE>>> ' + sql.slice(p, p + 120));
    }
    if (e.where) console.log('      where: ' + e.where);
    return null;
  }
}

async function smoke(file, again) {
  const sql = fs.readFileSync(path.join(DIR, file), 'utf8');
  const label = file + (again ? ' (again)' : '');
  if (LOCAL_FAIL[file] && !asked.length) { console.log('skip  ' + label + ': ' + LOCAL_FAIL[file]); return; }
  const res = await run(label, sql);
  if (!res) return;
  const last = res[res.length - 1];
  const rows = (last && last.rows) || [];
  const known = LOCAL_FAIL_ROWS[file] || { rows: [] };
  const skipped = rows.filter(x => x.result !== 'PASS' && known.rows.indexOf(x.check_name) >= 0);
  const bad = rows.filter(x => x.result !== 'PASS' && skipped.indexOf(x) < 0);
  if (!rows.length || bad.length) failed++;
  console.log((rows.length && !bad.length ? 'PASS  ' : 'FAIL  ') + label + ': ' + (rows.length - bad.length - skipped.length) + '/' + rows.length + ' PASS' +
              (skipped.length ? ', ' + skipped.length + ' skipped: ' + known.why : ''));
  for (const x of bad) console.log('      FAIL ' + x.n + ' ' + x.check_name + ' :: ' + x.detail);
  if (process.env.SHOW) for (const x of rows) console.log('      ' + x.result + ' ' + x.check_name);
}

// One hash per table in the mog schema, over all its rows.
async function digest() {
  const out = {};
  const tables = (await db.query("select tablename from pg_tables where schemaname = 'mog' order by tablename")).rows;
  for (const { tablename } of tables) {
    const r = await db.query(`select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) as h from mog."${tablename}" x`);
    out[tablename] = r.rows[0].h;
  }
  return out;
}

// What Supabase has and PGlite doesn't: the extensions schema, the API
// roles, and the ICU collation the vendor sort names.
await run('prelude', `
  create schema if not exists extensions;
  create extension if not exists pgcrypto with schema extensions;
  do $$ begin create role anon; exception when duplicate_object then null; end $$;
  do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
  set allow_system_table_mods = on;
  do $$ begin
    if not exists (select 1 from pg_catalog.pg_collation where collname = 'und-x-icu') then
      execute 'create collation pg_catalog."und-x-icu" from "C"';
    end if;
  end $$;
  reset allow_system_table_mods;
`);

for (const f of chain) {
  const r = await run(f, fs.readFileSync(path.join(SUPA, f), 'utf8'));
  if (!r) break;
  console.log('ok    ' + f);
}
if (!failed) {
  for (const s of smokes) await smoke(s, false);
  if (!asked.length) {
    // Re-running the newest file must change no row. Rows like the live
    // database's go in first, so a re-run that rewrites data shows up (v13:
    // a warehouse-only person, whom a re-run must not give the hq role).
    const newest = chain[chain.length - 1];
    await run('re-run fixture', `do $$ begin
      if to_regprocedure('mog.hq_invite(text, text[])') is not null then perform mog.hq_invite('zz rerun', '{warehouse}'); end if;
    end $$;`);
    const before = await digest();
    if (await run(newest + ' (again)', fs.readFileSync(path.join(SUPA, newest), 'utf8'))) {
      const after = await digest();
      const moved = Object.keys(after).filter(t => after[t] !== before[t]);
      if (moved.length) { failed++; console.log('FAIL  ' + newest + ' (again) changed rows in: ' + moved.join(', ')); }
      else console.log('ok    ' + newest + ' (again), no row changed');
    }
    const its = 'smoke_v' + num(newest) + '.sql';
    if (allSmokes.indexOf(its) >= 0) await smoke(its, true);
  }
}

console.log(failed ? `run_pglite: ${failed} FAILED` : 'run_pglite: ALL PASS');
process.exit(failed ? 1 : 0);
