// MOG's nightly close and recap: the Edge Function `close`
// (docs/MOG_SheetRetirement_Spec.md, step 2). pg_cron's tick posts here when
// mog.night_due() names something (supabase/night_schedule.sql); the work
// itself is core.mjs, which tests/night_close.test.js runs against the fake.
//
// This file is only the glue: the request's secret, the database calls, and
// Resend. Deployed with verify_jwt off: the caller proves itself with the
// secret Vault holds (mog_night_secret), checked in SQL before anything else
// runs. Nothing here reads a key from the repo:
//   SUPABASE_DB_URL  built in: the database, as its owner (the mog.* calls)
//   RESEND_API_KEY   set by a maintainer in Edge Functions -> Secrets
import postgres from 'npm:postgres@3.4.5';
import { runNight } from './core.mjs';

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
              one(sql`select mog.night_note(${slug}, ${step}, ${cycle}::date, ${ok}, ${sql.json(detail as any)}) as r`)
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// One email through Resend. A 429 (10 requests a second per team) or a 5xx
// is tried again, up to 3 times; anything else is the answer.
const mail = {
  async send(m: { from: string; to: string; subject: string; text: string; html: string; idempotencyKey?: string }) {
    const key = Deno.env.get('RESEND_API_KEY') ?? '';
    if (!key) return { ok: false, error: 'RESEND_API_KEY is not set' };
    const headers: Record<string, string> = { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
    if (m.idempotencyKey) headers['Idempotency-Key'] = m.idempotencyKey;
    const body = JSON.stringify({ from: m.from, to: [m.to], subject: m.subject, text: m.text, html: m.html });
    let last = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      const res = await fetch('https://api.resend.com/emails', { method: 'POST', headers, body });
      const text = await res.text();
      if (res.ok) {
        let id = null;
        try { id = JSON.parse(text).id; } catch (_) { /* the send went through either way */ }
        return { ok: true, id };
      }
      last = 'HTTP ' + res.status + ': ' + text.slice(0, 200);
      if (res.status !== 429 && res.status < 500) break;
      await sleep(1000 * attempt);
    }
    return { ok: false, error: last };
  }
};

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
