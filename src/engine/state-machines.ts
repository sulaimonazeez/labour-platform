import type { milestoneStatus, paymentState, quoteStatus, taskStatus } from "../db/schema/enums.js";

export type TaskStatus = (typeof taskStatus.enumValues)[number];
export type PaymentState = (typeof paymentState.enumValues)[number];
export type QuoteStatus = (typeof quoteStatus.enumValues)[number];
export type MilestoneStatus = (typeof milestoneStatus.enumValues)[number];

// PRD §134 — deterministic task transitions.
export const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  draft: ["ready", "cancelled"],
  ready: ["offered", "blocked", "cancelled"],
  offered: ["assigned", "ready", "cancelled"],
  assigned: ["accepted", "offered", "cancelled"],
  accepted: ["in_progress", "blocked", "cancelled"],
  in_progress: ["submitted", "blocked", "disputed", "cancelled"],
  submitted: ["approved", "in_progress", "disputed"],
  approved: ["completed", "disputed"],
  completed: ["disputed"],
  blocked: ["ready", "assigned", "accepted", "in_progress", "cancelled"],
  cancelled: [],
  disputed: ["in_progress", "submitted", "approved", "completed", "cancelled"],
};

// PRD §135 — payment state is separate from task state.
export const PAYMENT_TRANSITIONS: Record<PaymentState, readonly PaymentState[]> = {
  created: ["pending", "failed"],
  pending: ["authorised", "funded", "failed"],
  authorised: ["funded", "secured", "failed", "refunded"],
  funded: ["secured", "refunded", "partially_refunded", "disputed"],
  secured: ["partially_released", "released", "refunded", "partially_refunded", "disputed", "chargeback"],
  partially_released: ["partially_released", "released", "partially_refunded", "disputed", "chargeback"],
  released: ["partially_refunded", "refunded", "disputed", "chargeback"],
  failed: [],
  refunded: [],
  partially_refunded: ["partially_refunded", "refunded", "disputed"],
  disputed: ["secured", "partially_released", "released", "refunded", "partially_refunded", "chargeback"],
  chargeback: [],
};

// PRD §53: quotes are versioned, never overwritten. `draft` is the provider's private working copy;
// `submitted` freezes that version; a revision request sends the quote back to the provider, who creates
// the next version (back to `draft`). `expired` is reserved for a future expiry job (acceptance checks
// valid_until itself, so correctness does not depend on that job).
export const QUOTE_TRANSITIONS: Record<QuoteStatus, readonly QuoteStatus[]> = {
  draft: ["submitted", "withdrawn"],
  submitted: ["accepted", "rejected", "revision_requested", "expired", "withdrawn"],
  revision_requested: ["draft", "rejected", "expired", "withdrawn"],
  accepted: [],
  rejected: [],
  expired: [],
  withdrawn: [],
};

// PRD §57, §134: milestone approval is separate from payment. `funded` and `released` belong to the payment
// flow (Step 3); until it exists a milestone can be submitted straight from `pending`.
export const MILESTONE_TRANSITIONS: Record<MilestoneStatus, readonly MilestoneStatus[]> = {
  pending: ["funded", "in_progress", "submitted", "cancelled"],
  funded: ["in_progress", "submitted", "cancelled", "disputed"],
  in_progress: ["submitted", "cancelled", "disputed"],
  submitted: ["approved", "in_progress", "disputed"],
  approved: ["released", "disputed"],
  released: ["disputed"],
  disputed: ["in_progress", "submitted", "approved", "released", "cancelled"],
  cancelled: [],
};

// PRD §58-60: a change is proposed, then accepted (and applied as a new baseline in the same transaction), rejected by the
// other party, or withdrawn by its proposer. `draft` and `under_review` exist in the enum for later UI states and are unused today.
export type ChangeStatus = "draft" | "proposed" | "under_review" | "accepted" | "rejected" | "withdrawn" | "applied";
export const CHANGE_TRANSITIONS: Record<ChangeStatus, readonly ChangeStatus[]> = {
  draft: ["proposed", "withdrawn"],
  proposed: ["accepted", "rejected", "withdrawn", "under_review"],
  under_review: ["accepted", "rejected", "withdrawn"],
  accepted: ["applied"],
  rejected: [],
  withdrawn: [],
  applied: [],
};

export function canTransition<S extends string>(
  table: Record<S, readonly S[]>,
  from: S,
  to: S,
): boolean {
  return table[from].includes(to);
}

export function assertTransition<S extends string>(
  table: Record<S, readonly S[]>,
  from: S,
  to: S,
): void {
  if (!canTransition(table, from, to)) {
    throw new Error(`Illegal transition: ${from} -> ${to}`);
  }
}
