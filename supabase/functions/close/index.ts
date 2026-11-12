// MOG's nightly close and recap: the Edge Function `close`
// (docs/MOG_SheetRetirement_Spec.md, step 2). pg_cron's tick posts here when
// mog.night_due() names something (supabase/night_schedule.sql); the work
// itself is core.mjs, which tests/night_close.test.js runs against the fake.
//
// This file is only the glue: the request's secret, the database calls, and
// the mail relay's address. Deployed with verify_jwt off: the caller proves
// itself with the secret Vault holds (mog_night_secret), checked in SQL
// before anything else runs. Nothing here reads a key from the repo:
//   SUPABASE_DB_URL   built in: the database, as its owner (the mog.* calls)
//   MOG_RELAY_SECRET  set by a maintainer in Edge Functions -> Secrets, copied
//                     from the mail relay's Script Properties (setupRelay)
import postgres from 'npm:postgres@3.4.5';
import { runNight, relayMailer } from './core.mjs';

// The mail relay (mail-relay/Relay.gs): its one deployment, the same one
// mail-relay/relay-target.json names (tests/mail_relay.test.js holds them
// equal). python deploy.py --relay keeps the address.
const RELAY_URL = 'https://script.google.com/macros/s/AKfycbz63P9uqcrQOiQMOLSNLjkhz95oG7-5eEBg4eqD4Ro1KOeI9IZUg25V0DnpnVM00KCmew/exec';

const sql = postgres(Deno.env.get('SUPABASE_DB_URL') ?? '', {
  max: 1, prepare: false, idle_timeout: 5, connect_timeout: 15
});

// Every mog.night_* call answers one jsonb value.
async function one(q: Promise<any[]>): Promise<any> {
  const rows = await q;
  return rows[0] ? rows[0].r : null;
}

const db = {
  secretOk: (s: string) => one(sql`select mog.night_secret_ok(${s}) as r`),
  due:      () => one(sql`select mog.night_due() as r`),
  plan:     (slug: string, step: string) => one(sql`select mog.night_plan(${slug}, ${step}) as r`),
  close:    (slug: string, closing: string, newCycle: string, newDow: string, rows: unknown, at: string, ms: number) =>
              one(sql`select mog.night_close(${slug}, ${closing}::date, ${newCycle}::date, ${newDow},
                                             ${sql.json(rows as any)}, ${at}::timestamptz, ${Math.round(ms)}::integer) as r`),
  recapClaim: (slug: string) => one(sql`select mog.night_recap_claim(${slug}) as r`),
  recapDone:  (slug: string, cycle: string, sent: number, failed: number, detail: unknown) =>
              one(sql`select mog.night_recap_done(${slug}, ${cycle}::date, ${sent}::integer, ${failed}::integer,
                                                  ${sql.json(detail as any)}) as r`),
  shadowDone: (slug: string, cycle: string, rows: unknown, ms: number) =>
              one(sql`select mog.night_shadow_done(${slug}, ${cycle}::date, ${sql.json(rows as any)}, ${Math.round(ms)}::integer) as r`),
  testData:   (slug: string, date: string) => one(sql`select mog.night_test_data(${slug}, ${date}::date) as r`),
  note:       (slug: string, step: string, cycle: string | null, ok: boolean, detail: unknown) =>
              one(sql`select mog.night_note(${slug}, ${step}, ${cycle}::date, ${ok}, ${sql.json(detail as any)}) as r`),
  // The backup watchdog (schema_v24.sql).
  backupClaim: () => one(sql`select mog.backup_alert_claim() as r`),
  backupDone:  (kind: string, ok: boolean, detail: unknown) =>
              one(sql`select mog.backup_alert_done(${kind}, ${ok}, ${sql.json(detail as any)}) as r`),
  backupTest:  () => one(sql`select mog.backup_test_data() as r`)
};

// One email per POST to the mail relay (core.mjs relayMailer).
const mail = relayMailer(fetch, RELAY_URL, (Deno.env.get('MOG_RELAY_SECRET') ?? '').trim());

const answer = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return answer({ ok: false, error: 'POST only' }, 405);
  let body: any = {};
  try { body = await req.json(); } catch (_) { body = {}; }
  try {
    if (!(await db.secretOk(req.headers.get('x-mog-night') ?? ''))) return answer({ ok: false, error: 'NOT_ALLOWED' }, 401);
    return answer(await runNight(db, mail, body, {}));
  } catch (e) {
    return answer({ ok: false, error: String((e as Error)?.message ?? e).slice(0, 300) }, 500);
  }
});
