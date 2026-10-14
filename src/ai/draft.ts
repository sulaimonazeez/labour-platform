import { and, desc, eq, or, sql } from "drizzle-orm";
import { z } from "zod";
import { projectTemplates, templateVersions } from "../db/schema";
import type { Executor } from "../db/types";
import { AiUnavailable } from "./providers";
import { extractJson, runAi } from "./govern";

// PRD §19-21: Retrieve -> Adapt -> Generate. A validated template is preferred over inventing a process.
// Whatever the source, the result is validated against ONE schema and persisted as a draft; nothing is operational
// until the owner accepts it (PRD §20).

const taskSchema = z.object({
  key: z.string().trim().min(1).max(40),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(3000).optional(),
  categoryKey: z.string().trim().max(120).optional(),
  skills: z.array(z.string().trim().max(80)).max(10).default([]),
  materialResponsibility: z.enum(["customer", "provider", "merchant", "shared", "not_applicable"]).default("not_applicable"),
  dependsOn: z.array(z.string().trim().max(40)).max(10).default([]),
  inspectionRequired: z.boolean().default(false),
  acceptanceCriteria: z.string().trim().max(1000).optional(),
});
export const draftSchema = z.object({
  title: z.string().trim().min(1).max(200),
  objective: z.string().trim().max(5000).optional(),
  stages: z.array(z.object({ name: z.string().trim().min(1).max(120), tasks: z.array(taskSchema).min(1).max(40) })).min(1).max(12),
  assumptions: z.array(z.string().trim().max(500)).max(20).default([]),
  risks: z.array(z.string().trim().max(500)).max(20).default([]),
  materials: z.array(z.string().trim().max(200)).max(30).default([]),
  questionsForProfessional: z.array(z.string().trim().max(500)).max(20).default([]),
});
export type Draft = z.infer<typeof draftSchema>;
export type DraftSource = "template" | "ai" | "rules";

export type DraftResult = {
  draft: Draft;
  source: DraftSource;
  templateVersionId: string | null;
  warnings: string[];
  /** PRD §107: what the reader may trust. */
  labels: ("ai_generated" | "rules_generated" | "from_template" | "professionally_verified")[];
  aiInteractionUsed: boolean;
};

/** Structural checks the schema cannot express: unique keys, known dependencies, no cycles. Returns problems. */
export function structuralProblems(d: Draft): string[] {
  const problems: string[] = [];
  const keys = new Set<string>();
  const deps = new Map<string, string[]>();
  for (const s of d.stages) for (const t of s.tasks) {
    if (keys.has(t.key)) problems.push(`duplicate task key "${t.key}"`);
    keys.add(t.key);
    deps.set(t.key, t.dependsOn);
  }
  for (const [k, ds] of deps) for (const x of ds) {
    if (!keys.has(x)) problems.push(`task "${k}" depends on unknown task "${x}"`);
    if (x === k) problems.push(`task "${k}" depends on itself`);
  }
  const state = new Map<string, 0 | 1 | 2>();
  const visit = (k: string): boolean => {
    if (state.get(k) === 1) return true;
    if (state.get(k) === 2) return false;
    state.set(k, 1);
    for (const x of deps.get(k) ?? []) if (keys.has(x) && visit(x)) return true;
    state.set(k, 2);
    return false;
  };
  for (const k of keys) if (visit(k)) { problems.push("dependencies form a cycle"); break; }
  return problems;
}

export function rulesDraft(opts: { text: string; categoryName: string | null; categoryKey: string | null; risk: string; path: string }): Draft {
  const title = (opts.text.split(/[.\n]/)[0] || opts.categoryName || "New project").trim().slice(0, 120) || "New project";
  const inspect = opts.risk === "high" || opts.risk === "critical" || opts.path !== "quick_service";
  const tasks: Draft["stages"][number]["tasks"] = [];
  if (inspect) tasks.push({ key: "inspect", title: "Site inspection and scoping", description: "Inspect on site, confirm the scope and produce a written quote.", skills: [], materialResponsibility: "not_applicable", dependsOn: [], inspectionRequired: true, acceptanceCriteria: "Written findings and recommendations with photos." });
  tasks.push({ key: "work", title: opts.categoryName ? `${opts.categoryName}: main work` : "Main work", description: opts.text.slice(0, 2000) || undefined, categoryKey: opts.categoryKey ?? undefined, skills: [], materialResponsibility: "not_applicable", dependsOn: inspect ? ["inspect"] : [], inspectionRequired: false, acceptanceCriteria: "Work completed as described and shown in after-photos." });
  tasks.push({ key: "handover", title: "Final check and handover", description: "Walk through the finished work with the customer and note anything outstanding.", skills: [], materialResponsibility: "not_applicable", dependsOn: ["work"], inspectionRequired: false, acceptanceCriteria: "Customer confirms the work, or lists what remains." });
  return {
    title, objective: opts.text.slice(0, 2000) || undefined,
    stages: [{ name: inspect ? "Inspect, then do the work" : "Do the work", tasks }],
    assumptions: ["This outline was built from simple rules, not from a specialist's design. Review it before accepting."],
    risks: opts.risk === "high" || opts.risk === "critical" ? ["This is higher-risk work. Use a provider with proof of qualification and insurance."] : [],
    materials: [], questionsForProfessional: inspect ? ["What materials and quantities does this need?", "Is a permit or inspection required where the work is done?"] : [],
  };
}

type TemplateBody = Record<string, unknown>;

export async function findTemplate(ex: Executor, categoryKey: string | null, marketCode: string, language: string) {
  if (!categoryKey) return null;
  const rows = await ex
    .select({ v: templateVersions, t: projectTemplates })
    .from(templateVersions)
    .innerJoin(projectTemplates, eq(projectTemplates.id, templateVersions.templateId))
    .where(and(
      eq(projectTemplates.categoryKey, categoryKey),
      eq(templateVersions.approvalState, "approved"),
      or(sql`${templateVersions.effectiveFrom} is null`, sql`${templateVersions.effectiveFrom} <= current_date`),
      or(sql`cardinality(${templateVersions.marketCodes}) = 0`, sql`${marketCode} = any(${templateVersions.marketCodes})`),
      eq(projectTemplates.visibility, "global"),
    ))
    .orderBy(desc(templateVersions.version));
  const best = rows.find((r) => r.v.language === language) ?? rows.find((r) => r.v.language === "en") ?? rows[0];
  return best ?? null;
}

const VERIFIED = new Set(["verified_expert", "professional_body", "government"]);

export async function buildDraft(ex: Executor, i: {
  userId: string; marketCode: string; language: string; text: string; answers?: Record<string, string>;
  categoryKey: string | null; categoryName: string | null; risk: string; path: string;
}): Promise<DraftResult> {
  const warnings: string[] = [];
  const text = i.text.trim();
  const fallback = rulesDraft({ text, categoryName: i.categoryName, categoryKey: i.categoryKey, risk: i.risk, path: i.path });

  // 1. RETRIEVE + ADAPT: an approved template wins.
  const tpl = await findTemplate(ex, i.categoryKey, i.marketCode, i.language);
  if (tpl) {
    const body = tpl.v.body as TemplateBody;
    const parsed = draftSchema.safeParse({ ...body, title: (body.title as string | undefined) ?? fallback.title, objective: text || (body.objective as string | undefined) });
    if (parsed.success) {
      const d = parsed.data;
      const problems = structuralProblems(d);
      if (problems.length === 0) {
        const labels: DraftResult["labels"] = ["from_template"];
        if (VERIFIED.has(tpl.v.sourceKind)) labels.push("professionally_verified");
        if (i.answers && Object.keys(i.answers).length > 0) d.assumptions.push(...Object.entries(i.answers).map(([q, a]) => `${q}: ${a}`).slice(0, 10));
        return { draft: d, source: "template", templateVersionId: tpl.v.id, warnings, labels, aiInteractionUsed: false };
      }
      warnings.push(`template ${tpl.t.key} v${tpl.v.version} is structurally invalid and was ignored`);
    } else warnings.push(`template ${tpl.t.key} v${tpl.v.version} does not match the draft shape and was ignored`);
  }

  // 2. GENERATE (optional AI), validated exactly like a template.
  try {
    const out = await runAi(ex, {
      userId: i.userId, purpose: "scope_draft", marketCode: i.marketCode, maxTokens: 2500,
      system: "You turn a customer's plain-language need into a structured project outline for a services marketplace. Reply with ONE JSON object only, no prose. Shape: {title, objective, stages:[{name, tasks:[{key,title,description,skills[],materialResponsibility,dependsOn[],inspectionRequired,acceptanceCriteria}]}], assumptions[], risks[], materials[], questionsForProfessional[]}. Task keys are short unique ids. Do not invent prices. List anything needing a qualified professional under questionsForProfessional. Never claim safety-critical work is safe without a professional.",
      prompt: `Need: ${text}\nCategory: ${i.categoryKey ?? "unknown"}\nRisk: ${i.risk}\nAnswers so far: ${JSON.stringify(i.answers ?? {})}`,
      context: { fallback },
    });
    const parsed = draftSchema.safeParse(extractJson(out.text));
    if (parsed.success) {
      const problems = structuralProblems(parsed.data);
      if (problems.length === 0) return { draft: parsed.data, source: "ai", templateVersionId: null, warnings, labels: ["ai_generated"], aiInteractionUsed: true };
      warnings.push(`AI draft rejected: ${problems.join("; ")}`);
    } else warnings.push("AI draft did not match the required shape and was ignored");
  } catch (e) {
    if (!(e instanceof AiUnavailable)) throw e;
    // AI off, over quota or failing: continue deterministically (PRD §20).
  }

  // 3. DETERMINISTIC floor: always available.
  return { draft: fallback, source: "rules", templateVersionId: null, warnings, labels: ["rules_generated"], aiInteractionUsed: false };
}
