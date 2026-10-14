import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  activityEvents, assignments, changeRequests, changeRequestTasks, disputeEntries, disputes, evidence, issues, milestones,
  projectBudgets, projects, providerProfiles, quoteLineItems, quoteVersions, quotes, stages, taskDependencies, tasks,
} from "../db/schema/index.js";
import type { Executor } from "../db/types.js";
import { getProjectRoles, isProviderOnly, PROJECT_MANAGERS, providerVisibleTaskIds } from "../authz/projects.js";
import { AiUnavailable } from "./providers.js";
import { runAi } from "./govern.js";

// PRD §33, §54, §104, §144 and the change-impact item of §105. Everything here is DETERMINISTIC first; the optional AI
// narrative is added on top, labelled, and never changes a number (PRD §20, §171).

export type Labelled<T> = T & { source: "record" | "ai"; aiProvider?: string };

async function narrate(ex: Executor, o: { userId: string; projectId: string; purpose: "brief" | "quote_compare" | "change_impact" | "dispute_summary"; system: string; facts: unknown; fallback: string }): Promise<{ text: string; provider: string } | null> {
  try {
    const out = await runAi(ex, {
      userId: o.userId, projectId: o.projectId, purpose: o.purpose, maxTokens: 700,
      system: `${o.system} Use ONLY the facts provided. Never invent numbers, dates, names or obligations. Do not decide legal liability. Keep it under 120 words.`,
      prompt: JSON.stringify(o.facts),
      context: { fallback: o.fallback },
    });
    return { text: out.text.trim(), provider: out.provider };
  } catch (e) {
    if (e instanceof AiUnavailable) return null;
    throw e;
  }
}

// ── authorised context for the project assistant (PRD §33) ───────────────────
export type Fact = { ref: string; text: string };

export async function projectFacts(ex: Executor, projectId: string, userId: string, taskId?: string): Promise<Fact[]> {
  const roles = await getProjectRoles(ex, projectId, userId);
  if (roles.length === 0) return [];
  const [p] = await ex.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!p) return [];
  const facts: Fact[] = [{ ref: "project", text: `Project "${p.title}". ${p.objective ?? ""}`.trim() }];
  const providerOnly = isProviderOnly(roles);
  const visible = providerOnly ? await providerVisibleTaskIds(ex, projectId, userId) : null;
  let ts = await ex.select().from(tasks).where(eq(tasks.projectId, projectId)).orderBy(asc(tasks.position));
  if (visible) ts = ts.filter((t) => visible.includes(t.id));
  if (taskId) ts = ts.filter((t) => t.id === taskId);
  for (const t of ts) {
    facts.push({ ref: `task:${t.id}`, text: `Task "${t.title}" is ${t.status}. ${t.description ?? ""}`.trim() });
    const reqs = t.evidenceRequirements ?? {};
    if (Object.keys(reqs).length > 0) facts.push({ ref: `task:${t.id}:evidence`, text: `Evidence required for "${t.title}": ${JSON.stringify(reqs)}` });
  }
  const taskIds = ts.map((t) => t.id);
  if (taskIds.length > 0) {
    const asg = await ex.select({ id: assignments.id }).from(assignments).where(inArray(assignments.taskId, taskIds));
    if (asg.length > 0) {
      const ms = await ex.select().from(milestones).where(and(eq(milestones.projectId, projectId), inArray(milestones.assignmentId, asg.map((a) => a.id))));
      for (const m of ms) facts.push({ ref: `milestone:${m.id}`, text: `Milestone "${m.title}" is ${m.status}. Acceptance criteria: ${m.acceptanceCriteria ?? "not stated"}.` });
    }
    const crs = await ex.select({ cr: changeRequests }).from(changeRequests)
      .innerJoin(changeRequestTasks, eq(changeRequestTasks.changeRequestId, changeRequests.id))
      .where(and(eq(changeRequests.projectId, projectId), eq(changeRequests.status, "applied"), inArray(changeRequestTasks.taskId, taskIds)));
    for (const { cr } of crs) facts.push({ ref: `change:${cr.id}`, text: `Approved change "${cr.title}": ${cr.description ?? ""} (schedule ${cr.scheduleDeltaDays >= 0 ? "+" : ""}${cr.scheduleDeltaDays} days).` });
  } else if (!providerOnly) {
    const crs = await ex.select().from(changeRequests).where(and(eq(changeRequests.projectId, projectId), eq(changeRequests.status, "applied")));
    for (const cr of crs) facts.push({ ref: `change:${cr.id}`, text: `Approved change "${cr.title}": ${cr.description ?? ""}` });
  }
  return facts;
}

const STOP = new Set(["the", "a", "an", "is", "are", "to", "of", "and", "or", "what", "do", "i", "my", "we", "it", "this", "that", "before", "for", "in", "on", "be", "can", "should", "need", "exactly", "expected"]);
export function relevantFacts(question: string, facts: Fact[], limit = 5): Fact[] {
  const q = question.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
  const scored = facts.map((f) => ({ f, s: q.reduce((n, w) => n + (f.text.toLowerCase().includes(w) ? 1 : 0), 0) + (f.ref === "project" ? 0.1 : 0) }));
  return scored.sort((a, b) => b.s - a.s).filter((x) => x.s > 0).slice(0, limit).map((x) => x.f);
}

export async function askAssistant(ex: Executor, o: { userId: string; projectId: string; taskId?: string; question: string }) {
  const facts = await projectFacts(ex, o.projectId, o.userId, o.taskId);
  const top = relevantFacts(o.question, facts);
  const record = top.length > 0 ? top.map((f) => f.text).join("\n") : "The project record has nothing about that. Ask the project manager.";
  try {
    const out = await runAi(ex, {
      userId: o.userId, projectId: o.projectId, purpose: "assistant_answer", maxTokens: 500,
      system: "You answer a person's question about their own project using ONLY the numbered facts. If the facts do not answer it, say you do not know and suggest asking the project manager. Never invent requirements, prices or dates.",
      prompt: `Facts:\n${facts.map((f, i) => `${i + 1}. ${f.text}`).join("\n")}\n\nQuestion: ${o.question}`,
      context: { fallback: record },
    });
    return { answer: out.text.trim(), source: "ai" as const, aiProvider: out.provider, basedOn: top.map((f) => f.ref), answered: top.length > 0 };
  } catch (e) {
    if (!(e instanceof AiUnavailable)) throw e;
    return { answer: record, source: "record" as const, basedOn: top.map((f) => f.ref), answered: top.length > 0 };
  }
}

// ── project brief + deterministic health (PRD §77, §143-144) ─────────────────
export type DerivedHealth = "on_track" | "attention_required" | "delayed" | "blocked" | "awaiting_approval" | "awaiting_payment" | "disputed";

export async function computeBrief(ex: Executor, projectId: string, userId: string) {
  const roles = await getProjectRoles(ex, projectId, userId);
  const isManager = roles.some((r) => PROJECT_MANAGERS.includes(r));
  const [p] = await ex.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!p) return null;
  const ts = await ex.select().from(tasks).where(eq(tasks.projectId, projectId));
  const ms = await ex.select().from(milestones).where(eq(milestones.projectId, projectId));
  const openIssues = await ex.select({ n: sql<number>`count(*)::int` }).from(issues).where(and(eq(issues.projectId, projectId), inArray(issues.status, ["open", "acknowledged"])));
  const pending = await ex.select({ n: sql<number>`count(*)::int` }).from(changeRequests).where(and(eq(changeRequests.projectId, projectId), inArray(changeRequests.status, ["draft", "proposed", "under_review"])));
  const dis = await ex.select({ n: sql<number>`count(*)::int` }).from(disputes).where(and(eq(disputes.projectId, projectId), inArray(disputes.status, ["open", "awaiting_response", "in_review"])));
  const [b] = await ex.select().from(projectBudgets).where(eq(projectBudgets.projectId, projectId)).limit(1);

  const now = Date.now();
  const done = ts.filter((t) => t.status === "approved" || t.status === "completed").length;
  const open = ts.filter((t) => t.status !== "cancelled");
  const late = open.filter((t) => t.plannedEnd && t.plannedEnd.getTime() < now && t.status !== "approved" && t.status !== "completed");
  const blocked = ts.filter((t) => t.status === "blocked");
  const submitted = ts.filter((t) => t.status === "submitted");
  const msSubmitted = ms.filter((m) => m.status === "submitted");
  const msUnfunded = ms.filter((m) => m.status === "pending");
  const sum = (xs: typeof ms) => xs.reduce((n, m) => n + m.amountMinor, 0);

  let derived: DerivedHealth = "on_track";
  if ((dis[0]?.n ?? 0) > 0 || ms.some((m) => m.status === "disputed")) derived = "disputed";
  else if (blocked.length > 0) derived = "blocked";
  else if (late.length > 0) derived = "delayed";
  else if (submitted.length > 0 || msSubmitted.length > 0) derived = "awaiting_approval";
  else if (msUnfunded.length > 0 && ts.some((t) => t.status === "accepted" || t.status === "in_progress")) derived = "awaiting_payment";
  else if ((openIssues[0]?.n ?? 0) > 0) derived = "attention_required";

  const next: { kind: string; text: string }[] = [];
  if (isManager) {
    for (const t of ts.filter((x) => x.status === "draft")) next.push({ kind: "task.ready", text: `Mark "${t.title}" ready so providers can be invited.` });
    for (const t of submitted) next.push({ kind: "task.review", text: `Review the submitted work for "${t.title}".` });
    for (const m of msSubmitted) next.push({ kind: "milestone.approve", text: `Approve or question milestone "${m.title}".` });
    for (const m of msUnfunded.slice(0, 3)) next.push({ kind: "milestone.fund", text: `Fund milestone "${m.title}".` });
    if ((pending[0]?.n ?? 0) > 0) next.push({ kind: "change.review", text: `${pending[0].n} change request(s) are waiting for a decision.` });
  }
  if ((openIssues[0]?.n ?? 0) > 0) next.push({ kind: "issue.open", text: `${openIssues[0].n} open issue(s).` });

  const facts = {
    project: p.title, total: ts.length, done, late: late.map((t) => t.title), blocked: blocked.map((t) => t.title),
    awaitingApproval: submitted.length + msSubmitted.length, openIssues: openIssues[0]?.n ?? 0, openDisputes: dis[0]?.n ?? 0,
  };
  const summary = `${done} of ${ts.length} tasks are done. ${late.length > 0 ? `${late.length} are late. ` : ""}${blocked.length > 0 ? `${blocked.length} are blocked. ` : ""}${facts.awaitingApproval > 0 ? `${facts.awaitingApproval} item(s) wait for approval. ` : ""}`.trim();
  const ai = await narrate(ex, { userId, projectId, purpose: "brief", system: "You summarise a project for a busy non-professional owner.", facts, fallback: summary });

  return {
    projectId, currency: p.currency, storedHealth: p.health, derivedHealth: derived,
    progress: { total: ts.length, done, ratio: ts.length === 0 ? 0 : done / ts.length },
    late: late.map((t) => ({ taskId: t.id, title: t.title, plannedEnd: t.plannedEnd })),
    blocked: blocked.map((t) => ({ taskId: t.id, title: t.title })),
    next,
    money: isManager ? {
      estimatedMinor: b?.estimatedMinor ?? null, approvedMinor: b?.approvedMinor ?? null,
      notFundedMinor: sum(msUnfunded), heldMinor: sum(ms.filter((m) => ["funded", "in_progress", "submitted", "approved"].includes(m.status))),
      releasedMinor: sum(ms.filter((m) => m.status === "released")), disputedMinor: sum(ms.filter((m) => m.status === "disputed")),
    } : null,
    counts: { openIssues: facts.openIssues, pendingChanges: pending[0]?.n ?? 0, openDisputes: facts.openDisputes },
    summary: ai?.text ?? summary,
    source: ai ? ("ai" as const) : ("record" as const),
    aiProvider: ai?.provider,
  };
}

// ── quote comparison (PRD §54): informational, never misrepresents a quote ───
export async function compareQuotes(ex: Executor, taskId: string, userId: string, projectId: string) {
  const qs = await ex
    .select({ q: quotes, name: providerProfiles.displayName })
    .from(quotes)
    .innerJoin(providerProfiles, eq(providerProfiles.id, quotes.providerProfileId))
    .where(and(eq(quotes.taskId, taskId), inArray(quotes.status, ["submitted", "revision_requested", "accepted"])));
  const rows: { quoteId: string; provider: string; status: string; version: number; currency: string; totalMinor: number; validUntil: Date | null; inspectionRequired: boolean; exclusions: string | null; byKind: Record<string, number>; optionalMinor: number }[] = [];
  for (const { q, name } of qs) {
    const [v] = await ex.select().from(quoteVersions).where(and(eq(quoteVersions.quoteId, q.id), isNotNull(quoteVersions.submittedAt))).orderBy(desc(quoteVersions.version)).limit(1);
    if (!v) continue;
    const lines = await ex.select().from(quoteLineItems).where(eq(quoteLineItems.quoteVersionId, v.id));
    const byKind: Record<string, number> = {};
    let optionalMinor = 0;
    for (const l of lines) { if (l.isOptional) optionalMinor += l.amountMinor; else byKind[l.kind] = (byKind[l.kind] ?? 0) + l.amountMinor; }
    rows.push({ quoteId: q.id, provider: name, status: q.status, version: v.version, currency: v.currency, totalMinor: v.totalMinor, validUntil: v.validUntil, inspectionRequired: v.inspectionRequired, exclusions: v.exclusions, byKind, optionalMinor });
  }
  const currencies = new Set(rows.map((r) => r.currency));
  const comparable = currencies.size <= 1;
  const watched = ["materials", "transport", "equipment", "inspection"];
  const warnings: string[] = [];
  if (!comparable) warnings.push("These quotes use different currencies, so they are not ranked. Totals are shown as given.");
  if (comparable && rows.length > 1) {
    for (const r of rows) {
      const missing = watched.filter((k) => !(k in r.byKind) && rows.some((o) => o.quoteId !== r.quoteId && (o.byKind[k] ?? 0) > 0));
      if (missing.length > 0) warnings.push(`${r.provider} lists no ${missing.join(", ")} while others do, so its total may not be comparable.`);
      if (r.exclusions) warnings.push(`${r.provider} states exclusions: ${r.exclusions.slice(0, 160)}`);
      if (r.validUntil && r.validUntil.getTime() < Date.now()) warnings.push(`${r.provider}'s quote has passed its validity date.`);
    }
  }
  const lowest = comparable && rows.length > 0 ? rows.reduce((a, b) => (b.totalMinor < a.totalMinor ? b : a)) : null;
  const fallback = rows.length === 0 ? "There are no submitted quotes to compare yet." : `${rows.length} quote(s). ${lowest ? `${lowest.provider} has the lowest stated total.` : ""} ${warnings.length > 0 ? "Check the notes before choosing on price alone." : ""}`.trim();
  const ai = rows.length > 1 ? await narrate(ex, { userId, projectId, purpose: "quote_compare", system: "You help a customer compare quotations fairly. Be informational and never misrepresent a provider's quote.", facts: { rows, warnings }, fallback }) : null;
  return { taskId, comparable, lowestQuoteId: lowest?.quoteId ?? null, quotes: rows, warnings, summary: ai?.text ?? fallback, source: ai ? ("ai" as const) : ("record" as const), aiProvider: ai?.provider };
}

// ── change impact (PRD §59, §105) ────────────────────────────────────────────
export async function changeImpact(ex: Executor, changeId: string, userId: string) {
  const [cr] = await ex.select().from(changeRequests).where(eq(changeRequests.id, changeId)).limit(1);
  if (!cr) return null;
  const direct = (await ex.select({ taskId: changeRequestTasks.taskId }).from(changeRequestTasks).where(eq(changeRequestTasks.changeRequestId, changeId))).map((r) => r.taskId);
  const edges = await ex.select({ taskId: taskDependencies.taskId, dependsOn: taskDependencies.dependsOnTaskId })
    .from(taskDependencies).innerJoin(tasks, eq(tasks.id, taskDependencies.taskId)).where(eq(tasks.projectId, cr.projectId));
  const downstream = new Set<string>();
  const queue = [...direct];
  while (queue.length > 0) {
    const cur = queue.shift() as string;
    for (const e of edges) if (e.dependsOn === cur && !downstream.has(e.taskId) && !direct.includes(e.taskId)) { downstream.add(e.taskId); queue.push(e.taskId); }
  }
  const allIds = [...direct, ...downstream];
  const named = allIds.length > 0 ? await ex.select({ id: tasks.id, title: tasks.title, status: tasks.status }).from(tasks).where(inArray(tasks.id, allIds)) : [];
  const asg = allIds.length > 0 ? await ex.select({ id: assignments.id }).from(assignments).where(inArray(assignments.taskId, allIds)) : [];
  const affectedMilestones = asg.length > 0 ? await ex.select({ id: milestones.id, title: milestones.title, status: milestones.status, amountMinor: milestones.amountMinor }).from(milestones).where(inArray(milestones.assignmentId, asg.map((a) => a.id))) : [];
  const out = {
    changeId, status: cr.status, currency: cr.currency, financialEffect: cr.financialEffect, costDeltaMinor: cr.costDeltaMinor, scheduleDeltaDays: cr.scheduleDeltaDays,
    directTasks: named.filter((t) => direct.includes(t.id)), downstreamTasks: named.filter((t) => downstream.has(t.id)), milestones: affectedMilestones,
    notes: [
      ...(affectedMilestones.some((m) => ["funded", "in_progress", "submitted", "approved", "released"].includes(m.status)) ? ["Some affected milestones are already funded or released; a price change needs a funding or credit adjustment."] : []),
      ...(downstream.size > 0 ? [`${downstream.size} later task(s) depend on the changed work and may move.`] : []),
    ],
  };
  const fallback = `This change touches ${direct.length} task(s)${downstream.size > 0 ? ` and ${downstream.size} that depend on them` : ""}, shifts the schedule by ${cr.scheduleDeltaDays} day(s) and the cost by ${cr.costDeltaMinor} minor units of ${cr.currency}.`;
  const ai = await narrate(ex, { userId, projectId: cr.projectId, purpose: "change_impact", system: "You explain the effect of a proposed project change to the people who must approve it.", facts: out, fallback });
  return { ...out, summary: ai?.text ?? fallback, source: ai ? ("ai" as const) : ("record" as const), aiProvider: ai?.provider };
}

// ── dispute summary (PRD §102-104): facts and claims kept apart ──────────────
export async function disputeSummary(ex: Executor, disputeId: string, userId: string) {
  const [d] = await ex.select().from(disputes).where(eq(disputes.id, disputeId)).limit(1);
  if (!d) return null;
  const entries = await ex.select().from(disputeEntries).where(eq(disputeEntries.disputeId, disputeId)).orderBy(asc(disputeEntries.createdAt));
  const facts: { ref: string; text: string }[] = [{ ref: "dispute", text: `Opened ${d.createdAt.toISOString()} about ${d.scopeType} for reason "${d.reason}". Status ${d.status}.` }];
  if (d.scopeType === "milestone" && d.scopeId) {
    const [m] = await ex.select().from(milestones).where(eq(milestones.id, d.scopeId)).limit(1);
    if (m) {
      facts.push({ ref: `milestone:${m.id}`, text: `Milestone "${m.title}" for ${m.amountMinor} minor units of ${m.currency}. Acceptance criteria: ${m.acceptanceCriteria ?? "not stated"}.` });
      const ev = await ex.select({ n: sql<number>`count(*)::int` }).from(evidence).where(eq(evidence.milestoneId, m.id));
      facts.push({ ref: "evidence", text: `${ev[0]?.n ?? 0} evidence item(s) are attached to this milestone.` });
    }
  }
  if (d.scopeType === "task" && d.scopeId) {
    const ev = await ex.select({ n: sql<number>`count(*)::int` }).from(evidence).where(eq(evidence.taskId, d.scopeId));
    facts.push({ ref: "evidence", text: `${ev[0]?.n ?? 0} evidence item(s) are attached to this task.` });
  }
  const timeline = await ex.select({ eventType: activityEvents.eventType, at: activityEvents.occurredAt })
    .from(activityEvents).where(and(eq(activityEvents.projectId, d.projectId), d.scopeId ? eq(activityEvents.subjectId, d.scopeId) : sql`true`)).orderBy(asc(activityEvents.occurredAt)).limit(40);
  const claims = entries.filter((e) => ["claim", "response"].includes(e.kind)).map((e) => ({ by: e.authorUserId === d.openedByUserId ? "opener" : "other party", kind: e.kind, text: e.body }));
  const fallback = `${claims.length} statement(s) so far. ${timeline.length} recorded event(s) relate to this item. A person decides the outcome.`;
  const ai = await narrate(ex, { userId, projectId: d.projectId, purpose: "dispute_summary", system: "You neutrally summarise a dispute. Separate recorded facts from each side's claims. Never say who is at fault.", facts: { facts, claims, timeline }, fallback });
  return { disputeId, facts, timeline, claims, unanswered: claims.every((c) => c.by === "opener") && d.status !== "resolved", summary: ai?.text ?? fallback, source: ai ? ("ai" as const) : ("record" as const), aiProvider: ai?.provider, note: "This summary organises the record. It does not decide liability." };
}

export const stagesOf = async (ex: Executor, projectId: string) => ex.select().from(stages).where(eq(stages.projectId, projectId)).orderBy(asc(stages.position));
