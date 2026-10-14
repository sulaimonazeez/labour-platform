import { and, eq, inArray } from "drizzle-orm";
import { messageTranslations, messages, users } from "../db/schema";
import type { Executor } from "../db/types";
import { extractJson, runAi } from "../ai/govern";
import { AiUnavailable, getTranslator, type Translation } from "../ai/providers";
import { logEvent } from "../lib/events";

// PRD §28-30. Original text is never touched; each translation is a separate row with provenance
// (provider, model, confidence, timestamp). Translation failing never blocks a message from being sent.

export type TranslationView = { text: string; language: string; provider: string; model: string | null; confidence: number | null; translatedAt: string };

async function translateOne(ex: Executor, userId: string | null, text: string, from: string | null, to: string): Promise<Translation | null> {
  const t = getTranslator();
  if (!t.available()) return null;
  try {
    if (t.via === "direct") return await t.translate({ text, from, to });
    const out = await runAi(ex, {
      userId, purpose: "translate", maxTokens: 800,
      system: "You are a professional translator for a work-coordination platform. Translate faithfully. Do not add, remove or soften anything, especially prices, quantities, dates and safety instructions. Reply with JSON only: {\"translation\": string, \"confidence\": number between 0 and 1}.",
      prompt: `Translate from ${from ?? "the source language"} to ${to}:\n\n${text}`,
      context: { text, to },
    });
    const j = extractJson(out.text) as { translation?: unknown; confidence?: unknown } | null;
    const translated = typeof j?.translation === "string" ? j.translation : out.provider === "mock" ? out.text : null;
    if (!translated) return null;
    const conf = typeof j?.confidence === "number" && j.confidence >= 0 && j.confidence <= 1 ? j.confidence : null;
    return { text: translated, provider: `ai:${out.provider}`, model: out.model, confidence: conf };
  } catch (e) {
    if (!(e instanceof AiUnavailable)) await logEvent(ex, "translation.failed", "warn", { to, message: e instanceof Error ? e.message.slice(0, 200) : "unknown" });
    return null;
  }
}

/** Stores one translation per distinct target language the readers need. Returns how many were stored. */
export async function storeTranslations(ex: Executor, messageId: string, senderUserId: string | null, text: string, from: string | null, targets: readonly string[]): Promise<number> {
  let n = 0;
  for (const to of new Set(targets)) {
    if (to === from) continue;
    const t = await translateOne(ex, senderUserId, text, from, to);
    if (!t) continue;
    const r = await ex.insert(messageTranslations).values({
      messageId, targetLanguage: to, translatedText: t.text, provider: t.provider, model: t.model,
      confidence: t.confidence === null ? null : t.confidence.toFixed(3),
    }).onConflictDoNothing().returning({ id: messageTranslations.id });
    n += r.length;
  }
  return n;
}

/** Languages readers of these users want (their preferred one), skipping people who turned auto-translate off. */
export async function readerLanguages(ex: Executor, userIds: readonly string[]): Promise<string[]> {
  if (userIds.length === 0) return [];
  const rows = await ex.select({ lang: users.preferredLanguage, auto: users.autoTranslate }).from(users).where(inArray(users.id, [...userIds]));
  return [...new Set(rows.filter((r) => r.auto).map((r) => r.lang))];
}

export async function translationsFor(ex: Executor, messageIds: readonly string[], language: string): Promise<Map<string, TranslationView>> {
  const out = new Map<string, TranslationView>();
  if (messageIds.length === 0) return out;
  const rows = await ex.select().from(messageTranslations)
    .where(and(inArray(messageTranslations.messageId, [...messageIds]), eq(messageTranslations.targetLanguage, language)));
  for (const r of rows) {
    out.set(r.messageId, {
      text: r.translatedText, language: r.targetLanguage, provider: r.provider, model: r.model,
      confidence: r.confidence === null ? null : Number(r.confidence), translatedAt: r.createdAt.toISOString(),
    });
  }
  return out;
}

export async function translateExisting(ex: Executor, messageId: string, to: string, requesterUserId: string): Promise<TranslationView | null> {
  const [m] = await ex.select({ text: messages.originalText, lang: messages.originalLanguage }).from(messages).where(eq(messages.id, messageId)).limit(1);
  if (!m) return null;
  await storeTranslations(ex, messageId, requesterUserId, m.text, m.lang, [to]);
  return (await translationsFor(ex, [messageId], to)).get(messageId) ?? null;
}
