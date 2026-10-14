export type Edge = { taskId: string; dependsOnTaskId: string };

/**
 * PRD §70: the engine enforces accepted dependencies deterministically.
 * Adding "taskId depends on dependsOnTaskId" creates a cycle iff dependsOnTaskId already
 * (directly or transitively) depends on taskId. A self-dependency is a cycle.
 * `edges` = every existing dependency edge in the project.
 */
export function wouldCreateCycle(edges: readonly Edge[], taskId: string, dependsOnTaskId: string): boolean {
  if (taskId === dependsOnTaskId) return true;
  const deps = new Map<string, string[]>();
  for (const e of edges) {
    const list = deps.get(e.taskId);
    if (list) list.push(e.dependsOnTaskId);
    else deps.set(e.taskId, [e.dependsOnTaskId]);
  }
  const seen = new Set<string>();
  const stack = [dependsOnTaskId];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    if (cur === taskId) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const next of deps.get(cur) ?? []) stack.push(next);
  }
  return false;
}
