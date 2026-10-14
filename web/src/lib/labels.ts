// Plain words for the statuses people see. The raw status never changes: this only changes what is shown.
export const TASK_LABEL: Record<string, string> = {
  draft: "Not open yet", ready: "Open for quotes", offered: "Invitations sent", assigned: "Waiting for provider",
  accepted: "Provider accepted", in_progress: "Work started", submitted: "Ready for review", approved: "Approved",
  completed: "Done", blocked: "Blocked", cancelled: "Cancelled", disputed: "In dispute",
};

export const MILESTONE_LABEL: Record<string, string> = {
  pending: "Not funded", funded: "Funded", in_progress: "Work started", submitted: "Submitted",
  approved: "Approved", released: "Released", cancelled: "Cancelled", disputed: "In dispute",
};

export const label = (map: Record<string, string>, value: string): string => map[value] ?? value.replaceAll("_", " ");
