import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/client";
import {
  assignments, evidence, evidenceKind, milestones, projectMembers, projects, providerProfiles, quoteVersions, quotes, stages, tasks,
} from "../db/schema";
import { requireAuth, type AuthEnv } from "../auth/middleware";
import { isProviderOnly, PROJECT_MANAGERS, requireProjectRole, type ProjectRole } from "../authz/projects";
import type { Executor } from "../db/types";
import { MAX_MINOR } from "../engine/quote-math";
import { canTransition, MILESTONE_TRANSITIONS, type MilestoneStatus } from "../engine/state-machines";
import { recordActivity } from "../lib/activity";
import { runIdempotent } from "../lib/idempotency";
import { ApiError, parseOrThrow, readJson, uuidParam } from "./http";
import { userHoldsAssignment } from "./evidence-routes";

// Milestones (PRD §57; DECISIONS D37-D40).
//   manager: POST /projects/:id/milestones
//   members: GET /projects/:id/milestones, GET /milestones/:id (providers see only their own)
//   provider: POST /milestones/:id/submit
//   approver: POST /milestones/:id/approve, POST /milestones/:id/request-changes
// Approval is NOT payment: funding and release arrive with the payment flow (Step 3).

const milestoneCols = {
  id: milestones.id,
  projectId: milestones.projectId,
  stageId: milestones.stageId,
  assignmentId: milestones.assignmentId,
  title: milestones.title,
  amountMinor: milestones.amountMinor,
  currency: milestones.currency,
  dueAt: milestones.dueAt,
  acceptanceCriteria: milestones.acceptanceCriteria,
  evidenceRequirements: milestones.evidenceRequirements,
  approverUserId: milestones.approverUserId,
  status: milestones.status,
  position: milestones.position,
  approvedAt: milestones.approvedAt,
  createdAt: milestones.createdAt,
  updatedAt: milestones.updatedAt,
};

const forbidden = () => new ApiError(403, "forbidden", "You do not have permission to do this");
const notFound = () => new ApiError(404, "not_found", "Not found");
const emptyOrNote = z.strictObject({ note: z.string().trim().min(1).max(1000).optional() });
const changesBody = z.strictObject({ reason: z.string().trim().min(1).max(1000) });

// Stored shape of milestones.evidence_requirements: { minCount, kinds }. Deterministic, no free text.
const requirementsBody = z.strictObject({
  minCount: z.int().min(0).max(20),
  kinds: z.array(z.enum(evidenceKind.enumValues)).max(12).optional(),
});

const createBody = z.strictObject({
  title: z.string().trim().min(1).max(200),
  amountMinor: z.int().min(1).max(MAX_MINOR),
  currency: z.string().regex(/^[A-Z]{3}$/),
  stageId: z.uuid().optional(),
  assignmentId: z.uuid().optional(),
  dueAt: z.iso.datetime().optional(),
  acceptanceCriteria: z.string().trim().min(1).max(4000).optional(),
  evidenceRequirements: requirementsBody.optional(),
  approverUserId: z.uuid().optional(),
});

type Req = { minCount: number; kinds: string[] };
function readReq(v: Record<string, unknown>): Req {
  const minCount = typeof v.minCount === "number" ? v.minCount : 0;
  const kinds = Array.isArray(v.kinds) ? (v.kinds as string[]) : [];
  return { minCount, kinds };
}

async function loadMilestone(ex: Executor, id: string, lock: boolean) {
  const q = ex.select(milestoneCols).from(milestones).where(eq(milestones.id, id)).limit(1);
  const [m] = lock ? await q.for("update") : await q;
  if (!m) throw notFound();
  return m;
}
type M = Awaited<ReturnType<typeof loadMilestone>>;

async function projectOpen(ex: Executor, projectId: string) {
  const [p] = await ex.select({ status: projects.status, currency: projects.currency, ownerUserId: projects.ownerUserId }).from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!p) throw notFound();
  if (p.status !== "draft" && p.status !== "active") throw new ApiError(409, "project_not_open", `A ${p.status} project cannot change milestones`);
  return p;
}

function needTransition(from: MilestoneStatus, to: MilestoneStatus) {
  if (!canTransition(MILESTONE_TRANSITIONS, from, to)) {
    throw new ApiError(409, "illegal_transition", `A ${from} milestone cannot move to ${to}`, { from, to, allowed: MILESTONE_TRANSITIONS[from] });
  }
}

/** Provider-side access: must hold the milestone's assignment. Provider-only members elsewhere get 404. */
async function requireMilestoneProvider(ex: Executor, m: M, userId: string) {
  const roles = await requireProjectRole(ex, m.projectId, userId);
  const holds = m.assignmentId ? await userHoldsAssignment(ex, m.assignmentId, userId, ["accepted", "active"]) : false;
  if (!holds) {
    if (isProviderOnly(roles)) throw notFound();
    throw forbidden();
  }
}

/** Approver-side access: only the named approver. Provider-only members cannot even see it (404). */
async function requireApprover(ex: Executor, m: M, userId: string) {
  const roles = await requireProjectRole(ex, m.projectId, userId);
  if (isProviderOnly(roles)) throw notFound();
  if (m.approverUserId !== userId) throw new ApiError(403, "not_approver", "Only the milestone's approver can do this");
}

const APPROVER_ROLES: readonly ProjectRole[] = [...PROJECT_MANAGERS, "finance_approver"];

export const projectMilestoneRoutes = new Hono<AuthEnv>();
projectMilestoneRoutes.use("*", requireAuth);

projectMilestoneRoutes.post("/:id/milestones", async (c) => {
  const userId = c.get("auth").userId;
  const projectId = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  const b = parseOrThrow(createBody, raw);

  return runIdempotent(c, { scope: "milestones.create", userId, body: raw }, async (tx) => {
    await requireProjectRole(tx, projectId, userId, PROJECT_MANAGERS);
    // Lock the project row: serialises concurrent milestone creates so the quote-total check cannot be raced.
    await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).limit(1).for("update");
    const project = await projectOpen(tx, projectId);
    if (b.currency !== project.currency) {
      throw new ApiError(400, "currency_mismatch", "Milestone currency must equal the project currency", { projectCurrency: project.currency });
    }

    if (b.stageId) {
      const [s] = await tx.select({ id: stages.id }).from(stages).where(and(eq(stages.id, b.stageId), eq(stages.projectId, projectId))).limit(1);
      if (!s) throw new ApiError(400, "stage_invalid", "stageId must be a stage of this project");
    }

    if (b.assignmentId) {
      // Same answer for "no such assignment" and "assignment of another project".
      const [a] = await tx
        .select({ id: assignments.id, status: assignments.status, agreed: quoteVersions.totalMinor, agreedCurrency: quoteVersions.currency })
        .from(assignments)
        .innerJoin(tasks, eq(tasks.id, assignments.taskId))
        .leftJoin(quotes, eq(quotes.id, assignments.quoteId))
        .leftJoin(quoteVersions, and(eq(quoteVersions.quoteId, quotes.id), eq(quoteVersions.version, quotes.acceptedVersion)))
        .where(and(eq(assignments.id, b.assignmentId), eq(tasks.projectId, projectId)))
        .limit(1);
      if (!a || (a.status !== "accepted" && a.status !== "active")) {
        throw new ApiError(400, "assignment_invalid", "assignmentId must be an accepted assignment of this project");
      }
      if (a.agreed === null || a.agreedCurrency !== b.currency) {
        throw new ApiError(409, "assignment_has_no_quote", "This assignment has no agreed quote in this currency");
      }
      const [sum] = await tx
        .select({ total: sql<string>`coalesce(sum(${milestones.amountMinor}), 0)` })
        .from(milestones)
        .where(and(eq(milestones.assignmentId, b.assignmentId), sql`${milestones.status} <> 'cancelled'`));
      const used = BigInt(sum?.total ?? "0");
      if (used + BigInt(b.amountMinor) > BigInt(a.agreed)) {
        throw new ApiError(409, "milestones_exceed_quote", "Milestones for this assignment would exceed the agreed quote", {
          agreedMinor: a.agreed, alreadyPlannedMinor: Number(used), remainingMinor: a.agreed - Number(used),
        });
      }
    }

    // The approver defaults to the project owner; otherwise it must be a manager or finance approver of the project.
    const approverUserId = b.approverUserId ?? project.ownerUserId;
    if (b.approverUserId) {
      const roles = await tx.select({ role: projectMembers.role }).from(projectMembers).where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, b.approverUserId)));
      if (!roles.some((r) => APPROVER_ROLES.includes(r.role))) {
        throw new ApiError(400, "approver_invalid", "approverUserId must be a project owner, manager or finance approver");
      }
    }

    const [pos] = await tx.select({ next: sql<number>`coalesce(max(${milestones.position}), -1) + 1` }).from(milestones).where(eq(milestones.projectId, projectId));
    const req = b.evidenceRequirements ? { minCount: b.evidenceRequirements.minCount, kinds: b.evidenceRequirements.kinds ?? [] } : {};
    const [row] = await tx
      .insert(milestones)
      .values({
        projectId,
        stageId: b.stageId ?? null,
        assignmentId: b.assignmentId ?? null,
        title: b.title,
        amountMinor: b.amountMinor,
        currency: b.currency,
        dueAt: b.dueAt ? new Date(b.dueAt) : null,
        acceptanceCriteria: b.acceptanceCriteria ?? null,
        evidenceRequirements: req,
        approverUserId,
        position: Number(pos?.next ?? 0),
      })
      .returning(milestoneCols);
    await recordActivity(tx, {
      projectId, actorUserId: userId, eventType: "milestone.created", subjectType: "milestone", subjectId: row.id,
      payload: { title: row.title, amountMinor: row.amountMinor, currency: row.currency, assignmentId: row.assignmentId },
    });
    return { status: 201, body: { milestone: row } };
  });
});

projectMilestoneRoutes.get("/:id/milestones", async (c) => {
  const userId = c.get("auth").userId;
  const projectId = uuidParam(c.req.param("id"));
  const roles = await requireProjectRole(db, projectId, userId);
  if (!isProviderOnly(roles)) {
    const rows = await db.select(milestoneCols).from(milestones).where(eq(milestones.projectId, projectId)).orderBy(asc(milestones.position));
    return c.json({ milestones: rows });
  }
  // PRD §34: a provider sees only milestones tied to their own assignments.
  const rows = await db
    .select(milestoneCols)
    .from(milestones)
    .innerJoin(assignments, eq(assignments.id, milestones.assignmentId))
    .innerJoin(providerProfiles, eq(providerProfiles.id, assignments.providerProfileId))
    .where(and(eq(milestones.projectId, projectId), eq(providerProfiles.userId, userId), inArray(assignments.status, ["accepted", "active", "completed"])))
    .orderBy(asc(milestones.position));
  return c.json({ milestones: rows });
});

export const milestoneRoutes = new Hono<AuthEnv>();
milestoneRoutes.use("*", requireAuth);

async function evidenceProgress(ex: Executor, m: M) {
  const req = readReq(m.evidenceRequirements);
  const conds = [eq(evidence.milestoneId, m.id)];
  if (req.kinds.length > 0) conds.push(inArray(evidence.kind, req.kinds as any));
  const [r] = await ex.select({ n: sql<number>`count(*)::int` }).from(evidence).where(and(...conds));
  return { required: req.minCount, kinds: req.kinds, have: Number(r?.n ?? 0) };
}

milestoneRoutes.get("/:id", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  const m = await loadMilestone(db, id, false);
  const roles = await requireProjectRole(db, m.projectId, userId);
  if (isProviderOnly(roles)) {
    const holds = m.assignmentId ? await userHoldsAssignment(db, m.assignmentId, userId, ["accepted", "active", "completed"]) : false;
    if (!holds) throw notFound();
  }
  return c.json({ milestone: m, evidenceProgress: await evidenceProgress(db, m) });
});

milestoneRoutes.post("/:id/submit", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  const b = parseOrThrow(emptyOrNote, raw ?? {});

  return runIdempotent(c, { scope: "milestones.submit", userId, body: raw }, async (tx) => {
    const first = await loadMilestone(tx, id, false);
    await requireMilestoneProvider(tx, first, userId);
    const m = await loadMilestone(tx, id, true);
    await projectOpen(tx, m.projectId);
    needTransition(m.status, "submitted");
    // PRD §48: the customer funds the stage, then the provider performs the work (D78). Without this an approved but
    // unfunded stage could never be paid, because payment creation requires `pending`. A stage with no amount has nothing to fund.
    if (m.status === "pending" && m.amountMinor > 0) {
      throw new ApiError(409, "milestone_not_funded", "This stage must be funded before work on it can be submitted", { status: m.status });
    }

    const progress = await evidenceProgress(tx, m);
    if (progress.have < progress.required) {
      throw new ApiError(409, "evidence_requirements_not_met", "Not enough evidence has been added for this milestone", progress);
    }
    const [row] = await tx.update(milestones).set({ status: "submitted" }).where(eq(milestones.id, id)).returning(milestoneCols);
    await recordActivity(tx, {
      projectId: m.projectId, actorUserId: userId, eventType: "milestone.submitted", subjectType: "milestone", subjectId: id,
      payload: { from: m.status, evidenceCount: progress.have, ...(b.note ? { note: b.note } : {}) },
    });
    return { status: 200, body: { milestone: row } };
  });
});

milestoneRoutes.post("/:id/approve", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  const b = parseOrThrow(emptyOrNote, raw ?? {});

  return runIdempotent(c, { scope: "milestones.approve", userId, body: raw }, async (tx) => {
    await requireApprover(tx, await loadMilestone(tx, id, false), userId);
    const m = await loadMilestone(tx, id, true);
    await projectOpen(tx, m.projectId);
    needTransition(m.status, "approved");
    const [row] = await tx.update(milestones).set({ status: "approved", approvedAt: new Date() }).where(eq(milestones.id, id)).returning(milestoneCols);
    await recordActivity(tx, {
      projectId: m.projectId, actorUserId: userId, eventType: "milestone.approved", subjectType: "milestone", subjectId: id,
      payload: { amountMinor: m.amountMinor, currency: m.currency, ...(b.note ? { note: b.note } : {}) },
    });
    return { status: 200, body: { milestone: row } };
  });
});

milestoneRoutes.post("/:id/request-changes", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  const b = parseOrThrow(changesBody, raw);

  return runIdempotent(c, { scope: "milestones.request_changes", userId, body: raw }, async (tx) => {
    await requireApprover(tx, await loadMilestone(tx, id, false), userId);
    const m = await loadMilestone(tx, id, true);
    await projectOpen(tx, m.projectId);
    needTransition(m.status, "in_progress");
    const [row] = await tx.update(milestones).set({ status: "in_progress" }).where(eq(milestones.id, id)).returning(milestoneCols);
    await recordActivity(tx, {
      projectId: m.projectId, actorUserId: userId, eventType: "milestone.changes_requested", subjectType: "milestone", subjectId: id,
      payload: { reason: b.reason },
    });
    return { status: 200, body: { milestone: row } };
  });
});
