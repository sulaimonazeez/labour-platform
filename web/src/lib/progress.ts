// Where a job is, as one number the tape can draw. Pure and deterministic: it only reads task statuses.
export const STAGES = ["Planned", "Quoting", "Awarded", "Working", "Done"] as const;

const STAGE_OF: Record<string, number> = {
  draft: 0, ready: 1, offered: 1, assigned: 2, accepted: 2, in_progress: 3, submitted: 3, approved: 4, completed: 4,
};

export type Progress = { value: number; stage: number; label: string };

export function progressFromCounts(counts: Record<string, number>): Progress {
  let total = 0;
  let sum = 0;
  for (const [status, n] of Object.entries(counts)) {
    const s = STAGE_OF[status];
    if (s === undefined) continue; // blocked, cancelled, disputed: they do not move the tape
    total += n;
    sum += s * n;
  }
  if (total === 0) return { value: 0, stage: 0, label: STAGES[0] };
  const value = sum / total / (STAGES.length - 1);
  const stage = Math.round(value * (STAGES.length - 1));
  return { value, stage, label: STAGES[stage] };
}

export function progressFromTasks(tasks: { status: string }[]): Progress {
  const counts: Record<string, number> = {};
  for (const t of tasks) counts[t.status] = (counts[t.status] ?? 0) + 1;
  return progressFromCounts(counts);
}
