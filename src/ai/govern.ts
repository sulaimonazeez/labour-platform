import { and, eq, sql } from "drizzle-orm";
import { aiInteractions, aiUsageDaily } from "../db/schema";
import type { Executor } from "../db/types";
import { isFeatureOn } from "../lib/flags";
import { logEvent } from "../lib/events";
import { AiUnavailable, getAi, type AiPurpose, type AiResponse } from "./providers";

// PRD §106, §147, §149: AI is used only where it helps, is metered per person, can be switched off by flag, and every
// call is logged. Anything that throws AiUnavailable MUST be caught by the caller, which then continues deterministically.

const dailyLimit = () => Number(process.env.AI_DAILY_LIMIT ?? 30);
const priceIn = () => Number(process.env.AI_PRICE_IN_MICROS_PER_MTOK ?? 0);
const priceOut = () => Number(process.env.AI_PRICE_OUT_MICROS_PER_MTOK ?? 0);
const today = () => new Date().toISOString().slice(0, 10);

export type RunAiInput = {
  userId: string | null;
  projectId?: string | null;
  purpose: AiPurpose;
  system: string;
  prompt: string;
  maxTokens?: number;
  context?: Record<string, unknown>;
  marketCode?: string;
};

export function aiStatus() {
  const p = getAi();
  return { provider: p.name, available: p.available(), dailyLimit: dailyLimit() };
}

export async function runAi(ex: Executor, i: RunAiInput): Promise<AiResponse & { provider: string }> {
  const provider = getAi();
  const log = (status: string, extra: Partial<typeof aiInteractions.$inferInsert> = {}) =>
    ex.insert(aiInteractions).values({
      userId: i.userId, projectId: i.projectId ?? null, purpose: i.purpose, provider: provider.name, status,
      inputChars: i.prompt.length, ...extra,
    });

  if (!provider.available()) {
    await log("disabled");
    throw new AiUnavailable("disabled", "AI is not enabled on this deployment");
  }
  if (!(await isFeatureOn(ex, "ai.enabled", { userId: i.userId ?? undefined, marketCode: i.marketCode }))
    || !(await isFeatureOn(ex, `ai.${i.purpose}`, { userId: i.userId ?? undefined, marketCode: i.marketCode }))) {
    await log("blocked");
    throw new AiUnavailable("flag", "AI is switched off for this feature");
  }
  if (i.userId) {
    const [u] = await ex.select().from(aiUsageDaily).where(and(eq(aiUsageDaily.userId, i.userId), eq(aiUsageDaily.day, today()))).limit(1);
    if (u && u.calls >= dailyLimit()) {
      await log("quota");
      throw new AiUnavailable("quota", "You have used today's AI allowance. Everything still works without it.");
    }
  }

  const t0 = Date.now();
  try {
    const out = await provider.complete({ purpose: i.purpose, system: i.system, prompt: i.prompt, maxTokens: i.maxTokens, context: i.context });
    const cost = Math.round(((out.inputTokens ?? 0) * priceIn() + (out.outputTokens ?? 0) * priceOut()) / 1_000_000);
    await log("ok", { model: out.model, outputChars: out.text.length, inputTokens: out.inputTokens ?? null, outputTokens: out.outputTokens ?? null, costMicros: cost, latencyMs: Date.now() - t0 });
    if (i.userId) {
      await ex.insert(aiUsageDaily).values({ userId: i.userId, day: today(), calls: 1, costMicros: cost })
        .onConflictDoUpdate({ target: [aiUsageDaily.userId, aiUsageDaily.day], set: { calls: sql`${aiUsageDaily.calls} + 1`, costMicros: sql`${aiUsageDaily.costMicros} + ${cost}` } });
    }
    return { ...out, provider: provider.name };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await log("error", { error: msg.slice(0, 300), latencyMs: Date.now() - t0 });
    await logEvent(ex, "ai.failed", "warn", { purpose: i.purpose, provider: provider.name, message: msg.slice(0, 200) });
    throw e instanceof AiUnavailable ? e : new AiUnavailable("error", "The AI service did not answer");
  }
}

/** Pulls the first JSON object out of a model answer (models sometimes wrap it in prose or fences). */
export function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}
