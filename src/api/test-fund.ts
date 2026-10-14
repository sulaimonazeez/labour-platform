import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { milestones } from "../db/schema";

/** Test shortcut: puts a stage in the state a secured payment leaves it in. Real funding is covered by test-payments. */
export async function forceFunded(id: string): Promise<void> {
  await db.update(milestones).set({ status: "funded" }).where(eq(milestones.id, id));
}
