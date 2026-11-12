// Runs supabase/backup_role.sql in PGlite after the whole schema chain and checks what the role
// can and can't do. PGlite's postgres is a superuser and Supabase's isn't (rolsuper false;
// createrole, createdb, replication, bypassrls true; measured 2026-11-11), so the file runs as
// sb_postgres, a non-superuser with those four powers that owns the mog schema, its tables and
// sequences: a statement only a superuser may run fails here as it does live. (The first version
// passed as superuser and failed live on "nosuperuser", 2026-11-11.) CI runs it after run_pglite.
//   npm ci                                         (once)
//   node supabase/tests/backup_role_pglite.mjs     ends "test_backup_role: ALL PASS"
//   ROLE_SQL=<file> node ...                       tests another copy (a planted defect)
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

// Supabase's postgres, as measured: not a superuser, owns mog.
await db.exec(`
  create role sb_postgres with login createrole createdb replication bypassrls inherit;
  alter schema mog owner to sb_postgres;
  do $$ declare r record; begin
    for r in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'mog' and c.relkind = 'r' loop
      execute format('alter table mog.%I owner to sb_postgres', r.relname);  -- its owned sequences follow
    end loop;
    for r in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'mog' and c.relkind = 'S' and pg_get_userbyid(c.relowner) <> 'sb_postgres' loop
      execute format('alter sequence mog.%I owner to sb_postgres', r.relname);
    end loop;
    -- Live, postgres made (so owns) every function; the role file grants on this one.
    if to_regprocedure('mog.backup_heartbeat(text, integer, bigint, bigint)') is not null then
      alter function mog.backup_heartbeat(text, integer, bigint, bigint) owner to sb_postgres;
    end if;
  end $$;`);
const mirrorOk = (await db.query(`select (select rolsuper from pg_roles where rolname = 'sb_postgres') s,
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'mog' and c.relkind in ('r','S') and pg_get_userbyid(c.relowner) <> 'sb_postgres') o`)).rows[0];
ok(mirrorOk.s === false && mirrorOk.o === 0, 'stand-in: sb_postgres is no superuser and owns every mog table and sequence');

const raw = fs.readFileSync(process.env.ROLE_SQL || path.join(SUPA, 'backup_role.sql'), 'utf8');
const swap = (s, a, b) => { const n = s.split(a).length - 1; if (n < 1) throw new Error('anchor not found: ' + a); return s.split(a).join(b); };
const roleSql = swap(raw, "current_user <> 'postgres'", "current_user <> 'sb_postgres'").split('for role postgres').join('for role sb_postgres');
const asPg = async sql => { try { return await db.exec('set role sb_postgres;\n' + sql); } finally { await db.exec('reset role;'); } };
const pwHash = async () => ((await db.query(`select rolpassword from pg_authid where rolname = 'mog_backup'`)).rows[0] || {}).rolpassword;

ok(!/password\s+'/i.test(raw.replace(/--.*$/gm, '')), 'the file holds no typed password');

let r1, err1 = '';
try { r1 = await asPg(roleSql); } catch (e) { err1 = e.message; }
ok(!err1, 'first run as the stand-in: no error' + (err1 ? ' (' + err1 + ')' : ''));
if (err1) { console.log(`test_backup_role: ${failed + 1} FAILED`); process.exit(1); }
const pw1 = r1[r1.length - 1].rows[0];
const v1 = Object.values(pw1)[0];
ok(r1[r1.length - 1].rows.length === 1 && /^[0-9a-f]{64}$/.test(v1), 'first run shows one 64-hex password (' + Object.keys(pw1)[0] + ')');
const hash1 = await pwHash();
ok(/^SCRAM-SHA-256\$/.test(hash1 || ''), 'stored as a SCRAM hash');

const role = (await db.query(`select rolcanlogin, rolbypassrls, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolconnlimit, rolconfig from pg_roles where rolname = 'mog_backup'`)).rows[0];
ok(role.rolcanlogin && role.rolbypassrls && !role.rolsuper && !role.rolcreaterole && !role.rolcreatedb && !role.rolreplication, 'login + bypassrls, nothing else');
ok(role.rolconnlimit === 2, 'connection limit 2');
ok(JSON.stringify(role.rolconfig) === JSON.stringify(['default_transaction_read_only=on']), 'read-only by default: ' + JSON.stringify(role.rolconfig));

const priv = (await db.query(`
  select count(*)::int as tables,
         count(*) filter (where has_table_privilege('mog_backup', c.oid, 'select'))::int as can_read,
         count(*) filter (where has_table_privilege('mog_backup', c.oid, 'insert,update,delete,truncate'))::int as can_write
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'mog' and c.relkind = 'r'`)).rows[0];
ok(priv.tables > 30 && priv.can_read === priv.tables && priv.can_write === 0, `reads all ${priv.tables} mog tables (${priv.can_read}), writes none (${priv.can_write})`);
const seq = (await db.query(`
  select count(*)::int as seqs, count(*) filter (where has_sequence_privilege('mog_backup', c.oid, 'select'))::int as can_read,
         count(*) filter (where has_sequence_privilege('mog_backup', c.oid, 'update'))::int as can_write
    from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'mog' and c.relkind = 'S'`)).rows[0];
ok(seq.can_read === seq.seqs && seq.can_write === 0, `reads all ${seq.seqs} sequences, writes none`);
const usage = (await db.query(`select has_schema_privilege('mog_backup','mog','usage') m, has_schema_privilege('mog_backup','public','usage') p, has_schema_privilege('mog_backup','mog','create') c`)).rows[0];
ok(usage.m && usage.p && !usage.c, 'usage on mog and public, no create');

// A table a later schema file adds (created by the same owner) is readable too.
await asPg(`create table mog.zz_later (id int); create sequence mog.zz_later_seq;`);
const later = (await db.query(`select has_table_privilege('mog_backup','mog.zz_later','select') t, has_table_privilege('mog_backup','mog.zz_later','insert') w, has_sequence_privilege('mog_backup','mog.zz_later_seq','select') s`)).rows[0];
ok(later.t && !later.w && later.s, 'a later table and sequence are readable, not writable');
await db.exec(`drop table mog.zz_later; drop sequence mog.zz_later_seq;`);

// Re-running rotates the password and changes nothing else.
const r2 = await asPg(roleSql);
const v2 = Object.values(r2[r2.length - 1].rows[0])[0];
const hash2 = await pwHash();
ok(/^[0-9a-f]{64}$/.test(v2) && v2 !== v1 && hash2 !== hash1, 're-run: a new password');
const role2 = (await db.query(`select rolcanlogin, rolbypassrls, rolconnlimit, rolconfig from pg_roles where rolname = 'mog_backup'`)).rows[0];
ok(JSON.stringify(role2) === JSON.stringify({ rolcanlogin: role.rolcanlogin, rolbypassrls: role.rolbypassrls, rolconnlimit: role.rolconnlimit, rolconfig: role.rolconfig }), 're-run: same attributes');
ok((await db.query(`select count(*)::int n from pg_roles where rolname = 'mog_backup'`)).rows[0].n === 1, 're-run: still one role');

// As the role itself: it reads, and a write is refused.
await db.exec(`set role mog_backup; set default_transaction_read_only = on;`);
const n = (await db.query(`select count(*)::int n from mog.stores`)).rows[0].n;
ok(typeof n === 'number', 'as mog_backup: select from mog.stores works');
let refused = '';
try { await db.exec(`insert into mog.stores (slug) values ('zz_never')`); } catch (e) { refused = e.message; }
ok(/read-only|permission denied/.test(refused), 'as mog_backup: an insert is refused (' + refused + ')');
// Schema v24's watchdog: the heartbeat is the one write, and only in a transaction opened read-write
// (SebHEH/mog-backup's scripts/heartbeat.sh does exactly this).
let hbRo = '';
try { await db.exec(`select mog.backup_heartbeat('zz role run', 37, 100, 1000)`); } catch (e) { hbRo = e.message; }
ok(/read-only/.test(hbRo), 'as mog_backup: the heartbeat is refused in the default read-only transaction (' + hbRo + ')');
let hbRw = '';
try { await db.exec(`start transaction read write; select mog.backup_heartbeat('zz role run', 37, 100, 1000); commit;`); } catch (e) { hbRw = e.message; try { await db.exec('rollback'); } catch (_) { /* none open */ } }
ok(!hbRw, 'as mog_backup: the heartbeat writes in a read-write transaction' + (hbRw ? ' (' + hbRw + ')' : ''));
let hbDirect = '', hbClaim = '';
try { await db.exec(`start transaction read write; insert into mog.backup_heartbeats (run_id, tables, row_total, dump_bytes) values ('zz', 1, 1, 1); commit;`); } catch (e) { hbDirect = e.message; try { await db.exec('rollback'); } catch (_) { /* none open */ } }
try { await db.exec(`start transaction read write; select mog.backup_alert_claim(); commit;`); } catch (e) { hbClaim = e.message; try { await db.exec('rollback'); } catch (_) { /* none open */ } }
ok(/permission denied/.test(hbDirect) && /permission denied/.test(hbClaim), 'as mog_backup: a direct insert and the alert claim are refused');
await db.exec(`reset role; reset default_transaction_read_only;`);
ok((await db.query(`select count(*)::int n from mog.backup_heartbeats where run_id = 'zz role run'`)).rows[0].n === 1, 'the heartbeat row is there, once');
await db.exec(`delete from mog.backup_heartbeats where run_id = 'zz role run'`);

// Run as another role: refused before any change.
await db.exec(`create role zz_other; drop function pg_temp.mog_backup_role();`);
const hash3 = await pwHash();
let other = '';
try { await db.exec(`set role zz_other;` + roleSql); } catch (e) { other = e.message; }
await db.exec(`reset role;`);
ok(/Run this as postgres/.test(other) && (await pwHash()) === hash3, 'as another role: refused, password unchanged (' + other + ')');

// A mog_backup that already has more power is refused, not quietly kept.
await db.exec(`drop function if exists pg_temp.mog_backup_role(); alter role mog_backup createdb;`);
const hash4 = await pwHash();
let over = '';
try { await asPg(roleSql); } catch (e) { over = e.message; }
ok(/more power than a backup needs/.test(over) && (await pwHash()) === hash4, 'an over-powered mog_backup is refused, password unchanged');

console.log(failed ? `test_backup_role: ${failed} FAILED` : 'test_backup_role: ALL PASS');
process.exit(failed ? 1 : 0);
