import "dotenv/config";
import postgres from "postgres";
import { app } from "./app";

// Shared by the integration tests added from session 5 on (test-requests.ts keeps its own copy).

export async function call(method: string, path: string, opts: { body?: unknown; token?: string; key?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.key) headers["idempotency-key"] = opts.key;
  const res = await app.request(path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { status: res.status, json, text, replayed: res.headers.get("idempotent-replayed") === "true" };
}

export function expect(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

export async function registerUser(email: string) {
  const r = await call("POST", "/auth/register", {
    body: { email, password: "correct horse battery", displayName: "Test User", preferredLanguage: "en", timezone: "Africa/Lagos", marketCode: "NG" },
  });
  expect(r.status === 201, `register ${email} got ${r.status} ${r.text}`);
  const me = await call("GET", "/me", { token: r.json.token });
  return { token: r.json.token as string, id: me.json.user.id as string };
}

/** Registers a user and gives them a provider profile. Returns the token, user id and provider profile id. */
export async function registerProvider(email: string, tag: string) {
  const u = await registerUser(email);
  const p = await call("POST", "/providers/me", { body: {}, token: u.token, key: `pv-${tag}` });
  expect(p.status === 201, `create provider profile got ${p.status} ${p.text}`);
  return { ...u, providerId: p.json.provider.id as string };
}

/** Creates a request and converts it; returns the new project, its first stage and first task. */
export async function createProject(token: string, tag: string, text = "Test project") {
  const q = await call("POST", "/requests", { body: { rawText: text }, token, key: `rq-${tag}` });
  expect(q.status === 201, `create request got ${q.status} ${q.text}`);
  const p = await call("POST", `/requests/${q.json.request.id}/convert`, { body: { currency: "NGN" }, token, key: `cv-${tag}` });
  expect(p.status === 201, `convert got ${p.status} ${p.text}`);
  return { projectId: p.json.project.id as string, stageId: p.json.stageId as string, taskId: p.json.taskId as string };
}

/**
 * Removes test users matching `emailLike` and everything they own, via DIRECT_URL.
 * activity_events is append-only: the guard trigger is disabled and re-enabled INSIDE one transaction
 * (DDL is transactional, so a crash rolls it all back). Dev databases only.
 * Events written by the gateway webhook have a NULL actor, so activity is also deleted by project: otherwise they block deleting the project.
 */
export async function cleanupTestUsers(emailLike: string) {
  const url = process.env.DIRECT_URL;
  if (!url) { console.log("WARN  DIRECT_URL not set: skipping cleanup"); return; }
  const admin = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await admin.begin(async (t) => {
      const ids = (await t`select id from users where email like ${emailLike}`).map((r) => r.id as string);
      if (ids.length === 0) return;
      await t`alter table activity_events disable trigger trg_activity_events_append_only`;
      await t`delete from activity_events where actor_user_id in ${t(ids)} or project_id in (select id from projects where owner_user_id in ${t(ids)})
              or (subject_type = 'payout' and subject_id in (select id from payouts where provider_profile_id in (select id from provider_profiles where user_id in ${t(ids)})))`;
      await t`alter table activity_events enable trigger trg_activity_events_append_only`;
      await t`delete from idempotency_keys where right(scope, 36) in ${t(ids)}`;
      // Evidence is append-only (DB trigger) and milestones reference assignments: same trick, same transaction.
      await t`alter table evidence disable trigger trg_evidence_append_only`;
      await t`delete from evidence where project_id in (select id from projects where owner_user_id in ${t(ids)})`;
      await t`alter table evidence enable trigger trg_evidence_append_only`;
      // Payments: ledger entries/lines are append-only (triggers), and payments/milestones reference each other. Same trick, same transaction.
      await t`alter table ledger_lines disable trigger trg_ledger_lines_append_only`;
      await t`alter table ledger_entries disable trigger trg_ledger_entries_append_only`;
      // Entries to remove: this user's projects, their providers' payouts, and test-seed entries (payouttest:<providerId>:seed).
      await t`delete from ledger_lines where entry_id in (select id from ledger_entries where project_id in (select id from projects where owner_user_id in ${t(ids)})
              or payout_id in (select id from payouts where provider_profile_id in (select id from provider_profiles where user_id in ${t(ids)}))
              or idempotency_key in (select pfx || id::text || ':seed' from provider_profiles, unnest(array['payouttest:','adminview:']) as u(pfx) where user_id in ${t(ids)}))`;
      await t`delete from ledger_entries where project_id in (select id from projects where owner_user_id in ${t(ids)})
              or payout_id in (select id from payouts where provider_profile_id in (select id from provider_profiles where user_id in ${t(ids)}))
              or idempotency_key in (select pfx || id::text || ':seed' from provider_profiles, unnest(array['payouttest:','adminview:']) as u(pfx) where user_id in ${t(ids)})`;
      await t`delete from ledger_accounts where owner_key in (select 'project:' || id::text from projects where owner_user_id in ${t(ids)})
              or owner_key in (select 'provider:' || id::text from provider_profiles where user_id in ${t(ids)})
              or owner_key in (select 'suspense:payment:' || id::text from payments where project_id in (select id from projects where owner_user_id in ${t(ids)}))`;
      await t`alter table ledger_entries enable trigger trg_ledger_entries_append_only`;
      await t`alter table ledger_lines enable trigger trg_ledger_lines_append_only`;
      await t`delete from payments where project_id in (select id from projects where owner_user_id in ${t(ids)})`;
      await t`delete from milestones where project_id in (select id from projects where owner_user_id in ${t(ids)})`;
      // Quotes: submitted versions and their lines are frozen by triggers (even for DELETE), and
      // quotes/assignments/provider profiles have no cascade from projects/users. Same trick as above,
      // same transaction: disable, delete, re-enable. Order matters (assignments reference quotes).
      await t`alter table quote_versions disable trigger trg_quote_versions_freeze`;
      await t`alter table quote_line_items disable trigger trg_quote_line_items_freeze`;
      await t`delete from assignments where task_id in (select id from tasks where project_id in (select id from projects where owner_user_id in ${t(ids)}))`;
      await t`delete from quotes where project_id in (select id from projects where owner_user_id in ${t(ids)})
              or provider_profile_id in (select id from provider_profiles where user_id in ${t(ids)})`;
      await t`alter table quote_versions enable trigger trg_quote_versions_freeze`;
      await t`alter table quote_line_items enable trigger trg_quote_line_items_freeze`;
      await t`delete from payouts where provider_profile_id in (select id from provider_profiles where user_id in ${t(ids)})`;
      await t`delete from provider_payout_accounts where provider_profile_id in (select id from provider_profiles where user_id in ${t(ids)})`;
      // Reviews reference provider profiles and users without a cascade (session 11).
      await t`delete from reviews where project_id in (select id from projects where owner_user_id in ${t(ids)})
              or provider_profile_id in (select id from provider_profiles where user_id in ${t(ids)})
              or reviewer_user_id in ${t(ids)}`;
      await t`delete from provider_profiles where user_id in ${t(ids)}`;
      // Baselines are append-only (DB trigger, even for the cascade from projects): same trick, same transaction.
      await t`alter table project_baselines disable trigger trg_project_baselines_append_only`;
      await t`delete from project_baselines where project_id in (select id from projects where owner_user_id in ${t(ids)})`;
      await t`alter table project_baselines enable trigger trg_project_baselines_append_only`;
      await t`delete from projects where owner_user_id in ${t(ids)}`;
      await t`delete from requests where requester_user_id in ${t(ids)}`;
      await t`delete from users where id in ${t(ids)}`;
    });
  } catch (e) {
    console.log(`WARN  cleanup failed (test rows may remain): ${(e as Error).message}`);
  } finally {
    await admin.end({ timeout: 2 });
  }
}

/**
 * Test-only: makes a quote version's validity date already past. A submitted version is frozen by a trigger and
 * submit refuses a past date, so the only way to test expiry without sleeping is to bypass the trigger for this one
 * UPDATE (disabled and re-enabled inside one transaction, via DIRECT_URL). Dev databases only.
 */
export async function expireQuoteVersion(quoteId: string, version: number) {
  const url = process.env.DIRECT_URL;
  expect(url, "DIRECT_URL is required for this test");
  const admin = postgres(url as string, { max: 1, onnotice: () => {} });
  try {
    await admin.begin(async (t) => {
      await t`alter table quote_versions disable trigger trg_quote_versions_freeze`;
      await t`update quote_versions set valid_until = now() - interval '1 minute' where quote_id = ${quoteId} and version = ${version}`;
      await t`alter table quote_versions enable trigger trg_quote_versions_freeze`;
    });
  } finally {
    await admin.end({ timeout: 2 });
  }
}
