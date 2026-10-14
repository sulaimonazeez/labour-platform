// "What happens next", worked out from the project's real state. Pure and deterministic: the same data always gives the same
// answer, and it never invents a step (PRD §143 next actions, §77 health from data, not guesses).
export type Tab = "overview" | "money" | "changes" | "activity" | "more";
export const STEPS = ["Describe", "Quotes", "Choose", "Fund", "Work", "Approve and pay", "Done"] as const;

export type Action =
  | { kind: "markReady"; label: string; taskId: string }
  | { kind: "tab"; label: string; tab: Tab }
  | { kind: "link"; label: string; to: string };
export type Next = { step: number; title: string; body: string; action?: Action };

type T = { id: string; status: string; title: string };
type M = { id: string; status: string };
type P = { milestoneId: string | null; state: string };
const HELD = ["secured", "partially_released"];

const money = (label: string): Action => ({ kind: "tab", label, tab: "money" });

export function ownerNext(projectId: string, tasks: T[], milestones: M[], payments: P[]): Next {
  const live = tasks.filter((t) => t.status !== "cancelled");
  const ms = milestones.filter((m) => m.status !== "cancelled");
  const task = (...s: string[]) => live.find((t) => s.includes(t.status));
  const hasMs = (...s: string[]) => ms.some((m) => s.includes(m.status));

  if (live.length === 0) return { step: 0, title: "Add the work to be done", body: "A project needs at least one task. Describe it in plain words." };

  if (live.every((t) => t.status === "completed") && ms.every((m) => m.status === "released")) {
    return { step: 6, title: "All done", body: "The work is finished and paid. Leave a review so the next customer can trust this provider.", action: { kind: "tab", label: "Leave a review", tab: "more" } };
  }

  const approved = ms.find((m) => m.status === "approved");
  if (approved) {
    const held = payments.some((p) => p.milestoneId === approved.id && HELD.includes(p.state));
    return held
      ? { step: 5, title: "Release the payment", body: "You approved the work. Release the money to the provider.", action: money("Release payment") }
      : { step: 5, title: "Approved, but no funded payment is waiting", body: "Open the stage to see its payment.", action: money("See the stage") };
  }
  if (hasMs("submitted")) return { step: 5, title: "Review the work", body: "The provider says a stage is done. Check it, then approve it or ask for changes.", action: money("Review the stage") };

  const submitted = task("submitted");
  if (submitted) return { step: 5, title: "Review the submitted work", body: "The provider finished a task and sent it to you.", action: { kind: "link", label: "Review the work", to: `/projects/${projectId}/tasks/${submitted.id}` } };

  const unfunded = ms.find((m) => m.status === "pending");
  if (unfunded) {
    const started = payments.some((p) => p.milestoneId === unfunded.id && p.state === "pending");
    return started
      ? { step: 3, title: "Finish paying for the stage", body: "Your payment has started but has not arrived yet. Check on it.", action: money("Check the payment") }
      : { step: 3, title: "Fund a stage so work can start", body: "The provider starts once a stage is funded. The money is released only when you approve the work.", action: money("Fund a stage") };
  }

  if (task("accepted", "in_progress") && ms.length === 0) {
    return { step: 3, title: "Split the price into stages", body: "Your provider has accepted. Break the agreed price into stages, then fund the first one.", action: money("Add stages") };
  }
  if (hasMs("funded", "in_progress")) return { step: 4, title: "Work is underway", body: "A stage is funded. You will be asked to review it when the provider submits." };
  if (task("assigned")) return { step: 2, title: "Waiting for the provider to accept", body: "You chose a provider. They need to accept the job before work can be planned." };

  if (task("ready", "offered")) {
    return { step: 1, title: "Invite providers and review quotes", body: "Invite providers to quote. When quotes arrive, compare them and choose one.", action: { kind: "tab", label: "Invite providers", tab: "overview" } };
  }
  const draft = task("draft");
  if (draft) return { step: 0, title: "Open your task for quotes", body: "Providers can only be invited once the task is open.", action: { kind: "markReady", label: "Open for quotes", taskId: draft.id } };

  return { step: 4, title: "Nothing needs you right now", body: "Work is in progress. We will tell you when something needs your attention." };
}

export function providerNext(projectId: string, tasks: T[], milestones: M[]): Next {
  const live = tasks.filter((t) => t.status !== "cancelled");
  const ms = milestones.filter((m) => m.status !== "cancelled");
  const task = (...s: string[]) => live.find((t) => s.includes(t.status));
  const hasMs = (...s: string[]) => ms.some((m) => s.includes(m.status));
  const open = (t: T, label: string): Action => ({ kind: "link", label, to: `/projects/${projectId}/tasks/${t.id}` });

  if (live.length === 0) return { step: 1, title: "Nothing here yet", body: "Your work appears here once a customer invites you." };
  if (task("assigned")) return { step: 2, title: "You have been offered this job", body: "Accept it to take the work, or decline it.", action: { kind: "link", label: "Open your invitations", to: "/profile" } };
  if (ms.length > 0 && ms.every((m) => m.status === "released")) {
    return { step: 6, title: "You have been paid", body: "The money is in your earnings. You can ask for a payout there.", action: { kind: "link", label: "See your earnings", to: "/earnings" } };
  }
  if (hasMs("funded", "in_progress")) return { step: 4, title: "Do the work, then submit the stage", body: "This stage is funded. Add photos on the task page, then submit the stage when it is done.", action: money("Submit the stage") };
  if (hasMs("submitted")) return { step: 5, title: "Waiting for approval", body: "The customer is reviewing your stage." };
  if (hasMs("approved")) return { step: 5, title: "Approved: payment is being released", body: "The customer approved this stage." };
  const accepted = task("accepted");
  if (accepted) return { step: 3, title: "Start the work", body: "Open the task and start it. The customer funds a stage before you can submit it.", action: open(accepted, "Open the task") };
  if (hasMs("pending")) return { step: 3, title: "Waiting for the customer to fund your stage", body: "You can prepare now. You can submit a stage once it is funded." };
  const working = task("in_progress", "submitted");
  if (working) return { step: 4, title: "Work in progress", body: "Keep adding photos as you go.", action: open(working, "Open the work") };
  return { step: 4, title: "Nothing needs you right now", body: "We will tell you when something needs you." };
}
