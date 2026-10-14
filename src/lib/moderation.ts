import { moderationReports } from "../db/schema";
import type { Executor } from "../db/types";

// PRD §98-99: light, privacy-respecting screening. It never blocks or rewrites a message; it files a report for a person
// to review. Phone numbers, emails and links are flagged because contact details are released by workflow stage.
const PATTERNS: { reason: string; re: RegExp }[] = [
  { reason: "contact_leak", re: /(\+?\d[\d\s().-]{8,}\d)/ },
  { reason: "contact_leak", re: /[\w.+-]+@[\w-]+\.[\w.-]+/ },
  { reason: "payment_manipulation", re: /\b(pay me (directly|outside)|outside the (app|platform)|bank transfer to my)\b/i },
  { reason: "threat", re: /\b(i will (kill|hurt|burn)|you will regret|i know where you live)\b/i },
];

export function scanText(text: string): string[] {
  return [...new Set(PATTERNS.filter((p) => p.re.test(text)).map((p) => p.reason))];
}

export async function flagMessage(ex: Executor, messageId: string, text: string): Promise<string[]> {
  const reasons = scanText(text);
  for (const reason of reasons) {
    await ex.insert(moderationReports).values({ reporterUserId: null, targetType: "message", targetId: messageId, reason, detail: "automatic" });
  }
  return reasons;
}
