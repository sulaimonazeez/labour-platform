import "dotenv/config";
import postgres from "postgres";

// Exercises DB guards (sql/guards.sql) and CHECK/unique constraints.
// Each test runs in its own transaction that is ALWAYS rolled back.
// Needs the seed (languages, currencies, a market).  npm run db:test-guards

const url = process.env.DIRECT_URL;
if (!url) throw new Error("DIRECT_URL is not set");

const sql = postgres(url, { max: 1, onnotice: () => {} });

type Tx = postgres.TransactionSql;

class Rollback extends Error {}
class Skip extends Error {}

type Expect = { code?: string; match?: RegExp };

async function expectError(tx: Tx, label: string, fn: (sp: Tx) => Promise<unknown>, exp: Expect) {
  let err: unknown = null;
  try {
    await tx.savepoint(async (sp) => {
      await fn(sp as unknown as Tx);
    });
  } catch (e) {
    err = e;
  }
  if (!err) throw new Error(`${label}: expected an error but the statement succeeded`);
  const e = err as { code?: string; message?: string };
  if (exp.code && e.code !== exp.code) {
    throw new Error(`${label}: expected SQLSTATE ${exp.code}, got ${e.code} (${e.message})`);
  }
  if (exp.match && !exp.match.test(e.message ?? "")) {
    throw new Error(`${label}: message did not match ${exp.match}: ${e.message}`);
  }
}

async function id(rows: postgres.RowList<postgres.Row[]>): Promise<string> {
  const v = rows[0]?.id as string | undefined;
  if (!v) throw new Error("insert returned no id");
  return v;
}

const rnd = () => Math.random().toString(36).slice(2, 10);

type Fixture = {
  marketId: string;
  ownerId: string;
  providerUserId: string;
  providerProfileId: string;
  projectId: string;
  taskId: string;
};

async function fixture(tx: Tx): Promise<Fixture> {
  const m = await tx`select id from markets limit 1`;
  const marketId = m[0]?.id as string | undefined;
  if (!marketId) throw new Error("No market found. Run npm run db:seed first.");

  const ownerId = await id(await tx`
    insert into users (email, display_name, preferred_language, timezone)
    values (${`owner-${rnd()}@test.invalid`}, 'Test Owner', 'en', 'Africa/Lagos') returning id`);
  const providerUserId = await id(await tx`
    insert into users (email, display_name, preferred_language, timezone)
    values (${`prov-${rnd()}@test.invalid`}, 'Test Provider', 'en', 'Africa/Lagos') returning id`);
  const providerProfileId = await id(await tx`
    insert into provider_profiles (user_id, display_name) values (${providerUserId}, 'Test Provider') returning id`);
  const projectId = await id(await tx`
    insert into projects (owner_user_id, market_id, title, currency, timezone)
    values (${ownerId}, ${marketId}, 'Test project', 'NGN', 'Africa/Lagos') returning id`);
  const taskId = await id(await tx`
    insert into tasks (project_id, title) values (${projectId}, 'Test task') returning id`);
  return { marketId, ownerId, providerUserId, providerProfileId, projectId, taskId };
}

async function quoteVersion(tx: Tx, f: Fixture) {
  const quoteId = await id(await tx`
    insert into quotes (project_id, task_id, provider_profile_id)
    values (${f.projectId}, ${f.taskId}, ${f.providerProfileId}) returning id`);
  const versionId = await id(await tx`
    insert into quote_versions (quote_id, version, currency, total_minor, created_by_user_id)
    values (${quoteId}, 1, 'NGN', 100000, ${f.providerUserId}) returning id`);
  return { quoteId, versionId };
}

async function ledgerAccount(tx: Tx, kind: string, currency: string) {
  return id(await tx`
    insert into ledger_accounts (kind, owner_key, currency)
    values (${kind}::ledger_account_kind, ${`test:${rnd()}`}, ${currency}) returning id`);
}

async function ledgerEntry(tx: Tx, f: Fixture) {
  return id(await tx`
    insert into ledger_entries (kind, project_id, idempotency_key)
    values ('adjustment', ${f.projectId}, ${`test-${rnd()}`}) returning id`);
}

type TestFn = (tx: Tx) => Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
const test = (name: string, fn: TestFn) => tests.push({ name, fn });

// ---- append-only ----
test("activity_events: UPDATE and DELETE are rejected", async (tx) => {
  const f = await fixture(tx);
  const evId = await id(await tx`
    insert into activity_events (project_id, actor_type, event_type, subject_type)
    values (${f.projectId}, 'system', 'test.event', 'project') returning id`);
  await expectError(tx, "update", (sp) => sp`update activity_events set event_type = 'x' where id = ${evId}`, { match: /append-only/ });
  await expectError(tx, "delete", (sp) => sp`delete from activity_events where id = ${evId}`, { match: /append-only/ });
});

test("project_baselines: UPDATE is rejected", async (tx) => {
  const f = await fixture(tx);
  const bId = await id(await tx`
    insert into project_baselines (project_id, version, snapshot)
    values (${f.projectId}, 1, '{}'::jsonb) returning id`);
  await expectError(tx, "update", (sp) => sp`update project_baselines set version = 2 where id = ${bId}`, { match: /append-only/ });
});

test("evidence: UPDATE is rejected", async (tx) => {
  const f = await fixture(tx);
  const eId = await id(await tx`
    insert into evidence (project_id, task_id, uploader_user_id, kind)
    values (${f.projectId}, ${f.taskId}, ${f.ownerId}, 'photo_before') returning id`);
  await expectError(tx, "update", (sp) => sp`update evidence set mime_type = 'x' where id = ${eId}`, { match: /append-only/ });
});

// ---- quotes ----
test("quote_versions: draft editable, submitted version frozen", async (tx) => {
  const f = await fixture(tx);
  const { versionId } = await quoteVersion(tx, f);
  await tx`update quote_versions set notes = 'draft edit' where id = ${versionId}`;
  await tx`update quote_versions set submitted_at = now() where id = ${versionId}`;
  await expectError(tx, "edit after submit", (sp) => sp`update quote_versions set notes = 'x' where id = ${versionId}`, { match: /immutable/ });
  await expectError(tx, "delete after submit", (sp) => sp`delete from quote_versions where id = ${versionId}`, { match: /immutable/ });
});

test("quote_line_items: frozen once the version is submitted", async (tx) => {
  const f = await fixture(tx);
  const { versionId } = await quoteVersion(tx, f);
  const lineId = await id(await tx`
    insert into quote_line_items (quote_version_id, kind, description, unit_price_minor, amount_minor)
    values (${versionId}, 'labour', 'Work', 100000, 100000) returning id`);
  await tx`update quote_versions set submitted_at = now() where id = ${versionId}`;
  await expectError(tx, "insert", (sp) => sp`
    insert into quote_line_items (quote_version_id, kind, description, unit_price_minor, amount_minor)
    values (${versionId}, 'materials', 'More', 1, 1)`, { match: /immutable/ });
  await expectError(tx, "update", (sp) => sp`update quote_line_items set amount_minor = 1 where id = ${lineId}`, { match: /immutable/ });
  await expectError(tx, "delete", (sp) => sp`delete from quote_line_items where id = ${lineId}`, { match: /immutable/ });
});

test("quotes: must target a request or a project (CHECK)", async (tx) => {
  const f = await fixture(tx);
  await expectError(tx, "no target", (sp) => sp`
    insert into quotes (provider_profile_id) values (${f.providerProfileId})`, { code: "23514" });
});

// ---- chat ----
test("messages: original text/language/sender immutable, other columns editable", async (tx) => {
  const f = await fixture(tx);
  const convId = await id(await tx`
    insert into conversations (project_id, context_type, context_id)
    values (${f.projectId}, 'project', ${f.projectId}) returning id`);
  const msgId = await id(await tx`
    insert into messages (conversation_id, project_id, sender_user_id, original_text, original_language)
    values (${convId}, ${f.projectId}, ${f.ownerId}, 'Bonjour', 'fr') returning id`);
  await tx`update messages set attachments = '[]'::jsonb where id = ${msgId}`;
  await expectError(tx, "text", (sp) => sp`update messages set original_text = 'Hello' where id = ${msgId}`, { match: /immutable/ });
  await expectError(tx, "language", (sp) => sp`update messages set original_language = 'en' where id = ${msgId}`, { match: /immutable/ });
  await expectError(tx, "sender", (sp) => sp`update messages set sender_user_id = ${f.providerUserId} where id = ${msgId}`, { match: /immutable/ });
});

test("message_translations: UPDATE is rejected", async (tx) => {
  const f = await fixture(tx);
  const convId = await id(await tx`
    insert into conversations (project_id, context_type, context_id)
    values (${f.projectId}, 'project', ${f.projectId}) returning id`);
  const msgId = await id(await tx`
    insert into messages (conversation_id, project_id, sender_user_id, original_text, original_language)
    values (${convId}, ${f.projectId}, ${f.ownerId}, 'Bonjour', 'fr') returning id`);
  const trId = await id(await tx`
    insert into message_translations (message_id, target_language, translated_text, provider)
    values (${msgId}, 'en', 'Hello', 'test') returning id`);
  await expectError(tx, "update", (sp) => sp`update message_translations set translated_text = 'x' where id = ${trId}`, { match: /append-only/ });
});

// ---- ledger ----
test("ledger_lines: line currency must equal account currency", async (tx) => {
  const f = await fixture(tx);
  const acct = await ledgerAccount(tx, "protected_funds", "NGN");
  const entry = await ledgerEntry(tx, f);
  await expectError(tx, "currency mismatch", (sp) => sp`
    insert into ledger_lines (entry_id, account_id, direction, amount_minor, currency)
    values (${entry}, ${acct}, 'debit', 100, 'USD')`, { match: /does not match account currency/ });
});

test("ledger: balanced entry commits, unbalanced entry is rejected", async (tx) => {
  const f = await fixture(tx);
  const a = await ledgerAccount(tx, "external_clearing", "NGN");
  const b = await ledgerAccount(tx, "protected_funds", "NGN");

  const good = await ledgerEntry(tx, f);
  await tx`insert into ledger_lines (entry_id, account_id, direction, amount_minor, currency) values (${good}, ${a}, 'debit', 5000, 'NGN')`;
  await tx`insert into ledger_lines (entry_id, account_id, direction, amount_minor, currency) values (${good}, ${b}, 'credit', 5000, 'NGN')`;
  await tx`set constraints all immediate`;
  await tx`set constraints all deferred`;

  const bad = await ledgerEntry(tx, f);
  await expectError(tx, "unbalanced", async (sp) => {
    await sp`insert into ledger_lines (entry_id, account_id, direction, amount_minor, currency) values (${bad}, ${a}, 'debit', 5000, 'NGN')`;
    await sp`insert into ledger_lines (entry_id, account_id, direction, amount_minor, currency) values (${bad}, ${b}, 'credit', 4999, 'NGN')`;
    await sp`set constraints all immediate`;
  }, { match: /not balanced/ });
});

test("ledger_entries: idempotency key is unique", async (tx) => {
  const f = await fixture(tx);
  const key = `test-${rnd()}`;
  await tx`insert into ledger_entries (kind, project_id, idempotency_key) values ('adjustment', ${f.projectId}, ${key})`;
  await expectError(tx, "duplicate key", (sp) => sp`
    insert into ledger_entries (kind, project_id, idempotency_key) values ('adjustment', ${f.projectId}, ${key})`, { code: "23505" });
});

// ---- constraints ----
test("assignments: at most one live assignment per task", async (tx) => {
  const f = await fixture(tx);
  const first = await id(await tx`
    insert into assignments (task_id, provider_profile_id, status)
    values (${f.taskId}, ${f.providerProfileId}, 'offered') returning id`);
  await expectError(tx, "second live", (sp) => sp`
    insert into assignments (task_id, provider_profile_id, status)
    values (${f.taskId}, ${f.providerProfileId}, 'offered')`, { code: "23505" });
  await tx`update assignments set status = 'rejected' where id = ${first}`;
  await tx`insert into assignments (task_id, provider_profile_id, status) values (${f.taskId}, ${f.providerProfileId}, 'offered')`;
});

test("reviews: each rating must be 1-5", async (tx) => {
  const f = await fixture(tx);
  await expectError(tx, "rating 6", (sp) => sp`
    insert into reviews (project_id, reviewer_user_id, provider_profile_id, workmanship)
    values (${f.projectId}, ${f.ownerId}, ${f.providerProfileId}, 6)`, { code: "23514" });
  await expectError(tx, "rating 0", (sp) => sp`
    insert into reviews (project_id, reviewer_user_id, provider_profile_id, punctuality)
    values (${f.projectId}, ${f.ownerId}, ${f.providerProfileId}, 0)`, { code: "23514" });
  await tx`insert into reviews (project_id, reviewer_user_id, provider_profile_id, workmanship) values (${f.projectId}, ${f.ownerId}, ${f.providerProfileId}, 5)`;
});

test("payments: amount > 0 and released + refunded <= amount", async (tx) => {
  const f = await fixture(tx);
  await expectError(tx, "zero amount", (sp) => sp`
    insert into payments (project_id, payer_user_id, amount_minor, currency, provider_code, idempotency_key)
    values (${f.projectId}, ${f.ownerId}, 0, 'NGN', 'test', ${`k-${rnd()}`})`, { code: "23514" });
  await expectError(tx, "over-release", (sp) => sp`
    insert into payments (project_id, payer_user_id, amount_minor, currency, provider_code, idempotency_key, released_minor, refunded_minor)
    values (${f.projectId}, ${f.ownerId}, 1000, 'NGN', 'test', ${`k-${rnd()}`}, 700, 400)`, { code: "23514" });
  await tx`
    insert into payments (project_id, payer_user_id, amount_minor, currency, provider_code, idempotency_key, released_minor, refunded_minor)
    values (${f.projectId}, ${f.ownerId}, 1000, 'NGN', 'test', ${`k-${rnd()}`}, 600, 400)`;
});

test("payments: idempotency_key is unique", async (tx) => {
  const f = await fixture(tx);
  const key = `k-${rnd()}`;
  await tx`insert into payments (project_id, payer_user_id, amount_minor, currency, provider_code, idempotency_key) values (${f.projectId}, ${f.ownerId}, 1000, 'NGN', 'test', ${key})`;
  await expectError(tx, "duplicate", (sp) => sp`
    insert into payments (project_id, payer_user_id, amount_minor, currency, provider_code, idempotency_key)
    values (${f.projectId}, ${f.ownerId}, 1000, 'NGN', 'test', ${key})`, { code: "23505" });
});

test("users: needs an email or a phone (CHECK)", async (tx) => {
  await expectError(tx, "no contact", (sp) => sp`
    insert into users (display_name, preferred_language, timezone) values ('Nobody', 'en', 'Africa/Lagos')`, { code: "23514" });
});

test("evidence: must attach to a task or a milestone (CHECK)", async (tx) => {
  const f = await fixture(tx);
  await expectError(tx, "no target", (sp) => sp`
    insert into evidence (project_id, uploader_user_id, kind) values (${f.projectId}, ${f.ownerId}, 'document')`, { code: "23514" });
});

test("task_dependencies: no self dependency (CHECK)", async (tx) => {
  const f = await fixture(tx);
  await expectError(tx, "self dependency", (sp) => sp`
    insert into task_dependencies (task_id, depends_on_task_id) values (${f.taskId}, ${f.taskId})`, { code: "23514" });
});

// ---- Step 0 FK (meaningful after the new migration is applied) ----
test("project_baselines.created_by_change_request_id has a foreign key", async (tx) => {
  const c = await tx`select 1 as ok from pg_constraint where conname = 'project_baselines_cr_fk'`;
  if (c.length === 0) throw new Skip("FK not applied yet: run db:generate, db:migrate, db:guards");
  const f = await fixture(tx);
  await expectError(tx, "dangling reference", (sp) => sp`
    insert into project_baselines (project_id, version, snapshot, created_by_change_request_id)
    values (${f.projectId}, 2, '{}'::jsonb, gen_random_uuid())`, { code: "23503" });
});

// ---- runner ----
async function main() {
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const t of tests) {
    try {
      await sql.begin(async (tx) => {
        await t.fn(tx as unknown as Tx);
        throw new Rollback();
      });
    } catch (e) {
      if (e instanceof Rollback) {
        passed++;
        console.log(`PASS  ${t.name}`);
      } else if (e instanceof Skip) {
        skipped++;
        console.log(`SKIP  ${t.name} -- ${e.message}`);
      } else {
        failed++;
        console.log(`FAIL  ${t.name}\n      ${(e as Error).message}`);
      }
    }
  }

  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
  await sql.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await sql.end({ timeout: 1 }).catch(() => {});
  process.exit(1);
});
