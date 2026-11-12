// Runs supabase/night_schedule.sql in PGlite after the whole schema chain, with stand-ins for
// what PGlite doesn't have: Vault (vault.secrets, vault.decrypted_secrets, vault.create_secret),
// pg_net (net.http_post, recording each request) and pg_cron (cron.schedule, cron.job). The file's
// own `create extension` lines are left out; everything else runs as written. Checks: the secret is
// made once and never shown, the tick posts only when mog.night_due() names something and sends the
// secret, the test email posts its body, re-running changes nothing, and anon can call none of it.
// CI runs it after run_pglite.
//   npm ci                                            (once)
//   node supabase/tests/night_schedule_pglite.mjs     ends "night_schedule: ALL PASS"
//   SCHEDULE_SQL=<file> node ...                      tests another copy (a planted defect)
import fs from 'fs';
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
const REPO = process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NM = path.join(REPO, 'node_modules', '@electric-sql', 'pglite', 'dist');
const { PGlite } = await import(pathToFileURL(path.join(NM, 'index.js')).href);
const { pgcrypto } = await import(pathToFileURL(path.join(NM, 'contrib', 'pgcrypto.js')).href);
const SUPA = path.join(REPO, 'supabase');

const db = new PGlite({ extensions: { pgcrypto } });
let failed = 0;
const ok = (cond, what) => { if (!cond) failed++; console.log((cond ? 'PASS  ' : 'FAIL  ') + what); };
const one = async (sql, params) => (await db.query(sql, params || [])).rows[0];

await db.exec(`
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
  reset allow_system_table_mods;`);
const num = f => (f === 'schema.sql' ? 1 : Number((/^schema_v(\d+)\.sql$/.exec(f) || [])[1]));
const chain = fs.readdirSync(SUPA).filter(f => f === 'schema.sql' || /^schema_v\d+\.sql$/.test(f)).sort((a, b) => num(a) - num(b));
for (const f of chain) await db.exec(fs.readFileSync(path.join(SUPA, f), 'utf8'));
console.log('chain ran: ' + chain.length + ' files, up to ' + chain[chain.length - 1]);

// Stand-ins, shaped as Supabase's (vault 0.3, pg_net 0.20, pg_cron 1.6) for the calls the file makes.
await db.exec(`
  create schema vault;
  create table vault.secrets (id uuid primary key default gen_random_uuid(), name text unique, description text, secret text not null);
  create view vault.decrypted_secrets as select id, name, description, secret as decrypted_secret from vault.secrets;
  create function vault.create_secret(new_secret text, new_name text, new_description text default '')
  returns uuid language sql as $$
    insert into vault.secrets (name, description, secret) values (new_name, new_description, new_secret) returning id;
  $$;
  create schema net;
  create table net.requests (id bigserial primary key, url text, body jsonb, headers jsonb, timeout_milliseconds int);
  create function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb,
                                headers jsonb default '{}'::jsonb, timeout_milliseconds int default 2000)
  returns bigint language sql as $$
    insert into net.requests (url, body, headers, timeout_milliseconds) values (url, body, headers, timeout_milliseconds) returning id;
  $$;
  create schema cron;
  create table cron.job (jobid bigserial primary key, jobname text unique, schedule text, command text, active boolean default true);
  create function cron.schedule(job_name text, schedule text, command text) returns bigint language sql as $$
    insert into cron.job (jobname, schedule, command) values (job_name, schedule, command)
    on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command returning jobid;
  $$;
  create role postgres_stand_in;`);

const raw = fs.readFileSync(process.env.SCHEDULE_SQL || path.join(SUPA, 'night_schedule.sql'), 'utf8');
const lines = raw.split(/\r?\n/);
const sql = lines.filter(l => !/^\s*create extension\b/i.test(l) && !/^\s*grant .* schema cron to postgres;/i.test(l)
                             && !/^\s*grant all privileges on all tables in schema cron to postgres;/i.test(l)).join('\n');
ok(lines.length - sql.split('\n').length === 4, 'the file\'s own lines left out: the two extensions and the two cron grants (' + (lines.length - sql.split('\n').length) + ')');
ok(!/'[0-9a-f]{32,}'/.test(raw), 'the file holds no secret');

let err = '';
let res;
try { res = await db.exec(sql); } catch (e) { err = e.message; }
ok(!err, 'first run: no error' + (err ? ' (' + err + ')' : ''));
if (err) { console.log(`night_schedule: ${failed} FAILED`); process.exit(1); }
const last = res[res.length - 1].rows;
ok(last.length === 1 && last[0].jobname === 'mog-night' && last[0].schedule === '*/15 * * * *' && last[0].command === 'select mog.night_tick()',
   'the job: mog-night, every 15 minutes, select mog.night_tick()');
ok(!JSON.stringify(res.map(r => r.rows)).match(/[0-9a-f]{64}/), 'the run shows no secret');
const sec = await one(`select count(*)::int n, min(length(secret)) l from vault.secrets where name = 'mog_night_secret'`);
ok(sec.n === 1 && sec.l === 64, 'one secret, 64 hex characters, made in Vault');

// The tick: nothing due, nothing posted.
const t0 = await one(`select mog.night_tick() as id`);
ok(t0.id === null && (await one(`select count(*)::int n from net.requests`)).n === 0, 'nothing due: the tick posts nothing');

// A store whose recap is owed: the tick posts once, with the secret, to the function.
await db.exec(`
  select mog.provision_store('zzsched');
  insert into mog.store_state (slug, cycle_date, day_of_week, recap_due) values ('zzsched', current_date - 1, 'Mon', current_date - 1);`);
const t1 = await one(`select mog.night_tick() as id`);
const req = await one(`select r.url, r.body, r.headers ->> 'x-mog-night' = s.secret as secret_sent, r.timeout_milliseconds t
                         from net.requests r, vault.secrets s where s.name = 'mog_night_secret' order by r.id desc limit 1`);
ok(t1.id !== null && req && req.url === 'https://mnfwqmrstdeuczveyykv.supabase.co/functions/v1/close' && req.secret_sent
   && JSON.stringify(req.body) === '{}' && req.t === 150000, 'something due: one post to the close function, with the secret, 150 s');

// The function's check.
const chk = await one(`select mog.night_secret_ok((select secret from vault.secrets where name = 'mog_night_secret')) a,
                              mog.night_secret_ok('nope') b, mog.night_secret_ok(null) c, mog.night_secret_ok('') d`);
ok(chk.a === true && chk.b === false && chk.c === false && chk.d === false, 'night_secret_ok: the secret yes; wrong, null, empty no');

// The test email.
await one(`select mog.night_test('zzsched', date '2026-11-09', 'me@example.com') as id`);
const treq = await one(`select body from net.requests order by id desc limit 1`);
ok(JSON.stringify(treq.body) === JSON.stringify({ to: 'me@example.com', date: '2026-11-09', slug: 'zzsched', step: 'test' }),
   'night_test posts the test step: ' + JSON.stringify(treq.body));

// The backup watchdog (schema v24): its test posts the backup_test step with the secret, and a
// due alert makes the tick post like any other night step.
await one(`select mog.backup_watch_test() as id`);
const breq = await one(`select r.body, r.headers ->> 'x-mog-night' = s.secret as secret_sent
                          from net.requests r, vault.secrets s where s.name = 'mog_night_secret' order by r.id desc limit 1`);
ok(breq.secret_sent && JSON.stringify(breq.body) === JSON.stringify({ step: 'backup_test' }), 'backup_watch_test posts the backup_test step: ' + JSON.stringify(breq.body));
await db.exec(`update mog.store_state set recap_due = null where slug = 'zzsched';
               update mog.backup_watch set alert_to = 'me@example.com', watch_from = now() - interval '31 hours' where id;`);
const nb = (await one(`select count(*)::int n from net.requests`)).n;
const tb = await one(`select mog.night_tick() as id`);
ok(tb.id !== null && (await one(`select count(*)::int n from net.requests`)).n === nb + 1, 'a due backup alert: the tick posts once');
await db.exec(`update mog.backup_watch set alert_to = null, watch_from = now() where id;`);

// The log trim.
await db.exec(`insert into mog.night_log (slug, at, step, ok) values ('zzsched', now() - interval '91 days', 'close', true),
                                                                   ('zzsched', now() - interval '31 days', 'shadow', true),
                                                                   ('zzsched', now() - interval '31 days', 'close', true)`);
await one(`select mog.night_tick() as id`);
ok((await one(`select count(*)::int n from mog.night_log where slug = 'zzsched'`)).n === 1, 'the tick trims the log: 90 days, shadows 30');

// Re-running: the same secret, one job.
const before = (await one(`select secret from vault.secrets where name = 'mog_night_secret'`)).secret;
let err2 = '';
try { await db.exec(sql); } catch (e) { err2 = e.message; }
const after = await one(`select (select secret from vault.secrets where name = 'mog_night_secret') s, (select count(*)::int from cron.job) j`);
ok(!err2 && after.s === before && after.j === 1, 're-run: no error, the same secret, one job' + (err2 ? ' (' + err2 + ')' : ''));

// Nothing here for anon.
const priv = await one(`select has_function_privilege('anon', 'mog.night_tick()', 'execute') a,
                               has_function_privilege('anon', 'mog.night_secret_ok(text)', 'execute') b,
                               has_function_privilege('anon', 'mog.night_test(text, date, text)', 'execute') c,
                               has_function_privilege('anon', 'mog.backup_watch_test()', 'execute') d`);
ok(!priv.a && !priv.b && !priv.c && !priv.d, 'anon can call none of night_tick, night_secret_ok, night_test, backup_watch_test');

// supabase/tests/night_shadow_check.sql: a shadow that matches Apps Script's log, and one that doesn't.
await db.exec(`
  select mog.provision_store('zzshadow');
  insert into mog.store_state (slug, cycle_date, day_of_week) values ('zzshadow', date '2026-11-10', 'Tue');
  select mog.night_shadow_done('zzshadow', date '2026-11-10',
    '[{"vendor": "A", "id": "1", "name": "Shrimp", "pack": "CASE", "area": "Freezer", "onHandPrev": 1, "qty": 3},
      {"vendor": "A", "id": "2", "name": "Lids", "pack": "", "area": "", "onHandPrev": 0, "qty": 0},
      {"vendor": "B", "id": "3", "name": "Tea", "pack": "BAG", "area": "", "onHandPrev": 2.5, "qty": 1}]'::jsonb, 9);
  insert into mog.order_log (slug, cycle_date, seq, vendor, item_id, item_name, pack, area, on_hand_prev, qty_ordered, logged_at) values
    ('zzshadow', date '2026-11-10', 1, 'A', '1', 'Shrimp', 'CASE', 'Freezer', 1, 3, now()),
    ('zzshadow', date '2026-11-10', 3, 'B', '3', 'Tea', 'BAG', '', 2.50, 1, now());
  select mog.provision_store('zzshadow2');
  insert into mog.store_state (slug, cycle_date, day_of_week) values ('zzshadow2', date '2026-11-10', 'Tue');
  select mog.night_shadow_done('zzshadow2', date '2026-11-10',
    '[{"vendor": "A", "id": "1", "name": "Shrimp", "pack": "CASE", "area": "Freezer", "onHandPrev": 1, "qty": 3}]'::jsonb, 9);
  insert into mog.order_log (slug, cycle_date, seq, vendor, item_id, item_name, pack, area, on_hand_prev, qty_ordered, logged_at) values
    ('zzshadow2', date '2026-11-10', 1, 'A', '1', 'Shrimp', 'CASE', 'Freezer', 1, 4, now());`);
let check;
try { check = await db.exec(fs.readFileSync(path.join(SUPA, 'tests', 'night_shadow_check.sql'), 'utf8')); } catch (e) { check = null; ok(false, 'night_shadow_check.sql runs: ' + e.message); }
if (check) {
  const byStore = Object.fromEntries(check[0].rows.map(r => [r.slug, r]));
  const a = byStore.zzshadow, b = byStore.zzshadow2;
  ok(a && a.match === true && Number(a.shadow_rows) === 2 && Number(a.logged_rows) === 2 && a.first_difference === null,
     'night_shadow_check: the same close matches (2 rows each; the 0 line left out, 2.5 = 2.50)');
  ok(b && b.match === false && /x3 .* x4 /.test(String(b.first_difference)), 'night_shadow_check: a different quantity is named: ' + (b && b.first_difference));
  ok(check.length === 2, 'night_shadow_check: its second select (the night log) runs');
}

await db.exec(`delete from mog.stores where slug in ('zzsched', 'zzshadow', 'zzshadow2')`);
console.log(failed ? `night_schedule: ${failed} FAILED` : 'night_schedule: ALL PASS');
process.exit(failed ? 1 : 0);
