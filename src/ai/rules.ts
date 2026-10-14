import { and, eq, inArray } from "drizzle-orm";
import { serviceCategories, serviceCategorySynonyms, serviceCategoryTranslations } from "../db/schema/index.js";
import type { Executor } from "../db/types.js";

// PRD §3, §37, §80, §106: deterministic understanding of "what do you need done?". It reads the DATABASE taxonomy
// (canonical key + translated names + synonyms, PRD §24), so adding a language or a synonym needs no deploy.
// The result is a suggestion. Nothing here is an AI call.

export type RequestPath = "quick_service" | "ai_assisted" | "managed_project";
export type CatalogCategory = {
  key: string; parentKey: string | null; meaning: string; risk: string; name: string; description: string | null;
  synonyms: string[]; requiredCredentials: string[];
};

export function normalise(s: string): string {
  return s.toLowerCase().replace(/[’']/g, "").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

function hits(words: string[], padded: string, term: string): boolean {
  const t = normalise(term.replace(/\*$/, ""));
  if (!t) return false;
  if (term.endsWith("*")) return words.some((w) => w.startsWith(t));
  return padded.includes(` ${t} `);
}

export async function loadCatalog(ex: Executor, lang: string): Promise<CatalogCategory[]> {
  const cats = await ex.select().from(serviceCategories).where(eq(serviceCategories.isActive, true));
  if (cats.length === 0) return [];
  const ids = cats.map((c) => c.id);
  const names = await ex.select().from(serviceCategoryTranslations).where(inArray(serviceCategoryTranslations.categoryId, ids));
  const syns = await ex.select().from(serviceCategorySynonyms).where(inArray(serviceCategorySynonyms.categoryId, ids));
  const keyById = new Map(cats.map((c) => [c.id, c.canonicalKey]));
  return cats.map((c) => {
    const mine = names.filter((n) => n.categoryId === c.id);
    const pick = mine.find((n) => n.languageCode === lang) ?? mine.find((n) => n.languageCode === lang.split("-")[0]) ?? mine.find((n) => n.languageCode === "en") ?? mine[0];
    return {
      key: c.canonicalKey,
      parentKey: c.parentId ? keyById.get(c.parentId) ?? null : null,
      meaning: c.meaning,
      risk: c.riskLevel,
      name: pick?.name ?? c.canonicalKey,
      description: pick?.description ?? null,
      synonyms: syns.filter((s) => s.categoryId === c.id).map((s) => s.term),
      requiredCredentials: c.requiredCredentials ?? [],
    };
  });
}

const MANAGED = [
  /\brelocat/, /\bmoving (my |our |the )?(office|business|shop|store)\b/, /\b\d{2,}\s+(locations|facilities|branches|offices|sites|shops|stores)\b/,
  /\b(branches|facilities)\b/, /\bconference\b/, /\bopen(ing)? (a |an |another )?(new )?(restaurant|office|branch|shop|store|clinic)\b/,
  /\brenovat/, /\bconstruct/, /\bbuild(ing)? (a|an|my|our)\b/, /\bwhole (house|building)\b/, /\bmoving (to|house|out)\b/, /\bmove (house|out)\b/,
];
const GUIDED = [
  /\bsolar\b/, /\binverter/, /\bbackup (power|electricity)\b/, /\bnot sure\b/, /\bdont know\b/, /\bhelp me (figure|plan|decide|understand)\b/, /\bcctv\b/, /\bsmart home\b/,
];
const EMERGENCY: { re: RegExp; kind: string }[] = [
  { re: /\bgas (leak|smell)|smell(s|ing)? (of )?gas\b/, kind: "gas leak" },
  { re: /\bon fire\b|\bfire\b|\bsmoke\b|\bburning smell\b/, kind: "fire or smoke" },
  { re: /\belectrocut|\belectric shock\b|\bsparking\b|\bexposed live wire/, kind: "electrical hazard" },
  { re: /\binjured\b|\bunconscious\b|\bnot breathing\b|\bbleeding\b|\bchest pain\b|\bheart attack\b/, kind: "medical emergency" },
  { re: /\bintruder\b|\bbreak ?in\b|\bbeing attacked\b|\bsomeone is (inside|attacking)\b/, kind: "personal safety" },
];

export type Classification = {
  text: string;
  matches: { key: string; name: string; risk: string; score: number }[];
  topKey: string | null;
  confident: boolean;
  path: RequestPath;
  emergency: { kind: string; note: string } | null;
  source: "rules";
};

export const EMERGENCY_NOTE =
  "This could be an emergency. Contact your local emergency services first. This platform is a marketplace, not an emergency service.";

export function classifyAgainst(catalog: CatalogCategory[], input: string): Classification {
  const text = input.trim();
  const norm = normalise(text);
  const words = norm ? norm.split(" ") : [];
  const padded = ` ${norm} `;

  const scored: { c: CatalogCategory; score: number }[] = [];
  for (const c of catalog) {
    let score = 0;
    const terms = [...c.synonyms, `${c.name.toLowerCase()}`];
    for (const t of terms) if (hits(words, padded, t)) score += t.trim().includes(" ") ? 3 : 2;
    if (score > 0) scored.push({ c, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const confident = scored.length > 0 && (scored.length === 1 || scored[0].score >= scored[1].score + 2);

  let path: RequestPath = "quick_service";
  if (MANAGED.some((r) => r.test(norm))) path = "managed_project";
  else if (GUIDED.some((r) => r.test(norm))) path = "ai_assisted";

  const em = EMERGENCY.find((e) => e.re.test(norm));
  return {
    text,
    matches: scored.slice(0, 3).map((s) => ({ key: s.c.key, name: s.c.name, risk: s.c.risk, score: s.score })),
    topKey: scored[0]?.c.key ?? null,
    confident,
    path,
    emergency: em ? { kind: em.kind, note: EMERGENCY_NOTE } : null,
    source: "rules",
  };
}

export async function classify(ex: Executor, text: string, lang: string): Promise<Classification> {
  return classifyAgainst(await loadCatalog(ex, lang), text);
}

export async function categoryByKey(ex: Executor, key: string) {
  const [c] = await ex.select().from(serviceCategories).where(and(eq(serviceCategories.canonicalKey, key), eq(serviceCategories.isActive, true))).limit(1);
  return c ?? null;
}
