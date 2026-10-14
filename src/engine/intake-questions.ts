// Guided intake questions (PRD §17, §21, §37, §80, §106). Deterministic: stored question sets per category,
// no AI. "Retrieve before generate": AI may later reword or add questions, but this set always works offline.
// Only questions that change who qualifies or how urgent/dangerous the job is are asked.

export type QuestionType = "yes_no" | "single_select" | "text" | "number";

export type Question = {
  key: string;
  prompt: string;
  type: QuestionType;
  options?: readonly string[];
  required: boolean;
  /** Answer that means "possible emergency". true for yes_no, or an option value for single_select. */
  safetyWhen?: true | string;
};

export const EMERGENCY_MESSAGE =
  "If anyone is in danger, contact your local emergency services first. This platform is not an emergency service.";

const COMMON: Question[] = [
  { key: "urgency", prompt: "How soon do you need this done?", type: "single_select", options: ["asap", "today", "this_week", "flexible"], required: true },
  { key: "site_type", prompt: "Where is the work?", type: "single_select", options: ["house", "apartment", "office", "shop", "other"], required: true },
  { key: "details", prompt: "Anything else a professional should know?", type: "text", required: false },
];

const BY_CATEGORY: Record<string, Question[]> = {
  electrical_residential_installation: [
    { key: "burning_or_sparks", prompt: "Do you smell burning, see sparks, or feel a shock from anything?", type: "yes_no", required: true, safetyWhen: true },
    { key: "fault_scope", prompt: "How much of the property is affected?", type: "single_select", options: ["one_socket_or_light", "one_room", "several_rooms", "whole_property", "not_sure"], required: true },
    { key: "breaker_trips", prompt: "Does a breaker keep tripping?", type: "yes_no", required: false },
  ],
  plumbing_residential: [
    { key: "water_near_electrics", prompt: "Is water near sockets or appliances, or flooding fast?", type: "yes_no", required: true, safetyWhen: true },
    { key: "leak_location", prompt: "Where is the problem?", type: "single_select", options: ["ceiling", "wall", "floor", "tap_or_pipe", "toilet", "water_heater", "not_sure"], required: true },
    { key: "can_isolate_water", prompt: "Can you switch the water off at the mains?", type: "yes_no", required: false },
  ],
  cleaning_residential: [
    { key: "clean_type", prompt: "What kind of clean?", type: "single_select", options: ["regular", "deep_clean", "move_out", "post_construction", "office"], required: true },
    { key: "rooms", prompt: "How many rooms?", type: "number", required: false },
  ],
};

/** Category-specific questions first (safety ones lead), then the common ones. Unknown/no category: common only. */
export function questionsFor(categoryKey: string | null): Question[] {
  return [...(categoryKey ? BY_CATEGORY[categoryKey] ?? [] : []), ...COMMON];
}

export type AnswerValue = boolean | number | string;

function checkOne(q: Question, v: unknown): string | null {
  switch (q.type) {
    case "yes_no":
      return typeof v === "boolean" ? null : `${q.key} must be true or false`;
    case "single_select":
      return typeof v === "string" && q.options?.includes(v) ? null : `${q.key} must be one of: ${q.options?.join(", ")}`;
    case "number":
      return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100000 ? null : `${q.key} must be a number from 0 to 100000`;
    case "text":
      return typeof v === "string" && v.trim().length >= 1 && v.trim().length <= 1000 ? null : `${q.key} must be 1-1000 characters`;
  }
}

export function validateAnswers(
  qs: readonly Question[],
  answers: Record<string, unknown>,
): { ok: true; clean: Record<string, AnswerValue> } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const clean: Record<string, AnswerValue> = {};
  for (const [key, v] of Object.entries(answers)) {
    const q = qs.find((x) => x.key === key);
    if (!q) { errors.push(`${key} is not a question for this request`); continue; }
    const bad = checkOne(q, v);
    if (bad) errors.push(bad);
    else clean[key] = q.type === "text" ? (v as string).trim() : (v as AnswerValue);
  }
  return errors.length ? { ok: false, errors } : { ok: true, clean };
}

/** Keys of answered safety questions whose answer signals a possible emergency. */
export function safetyFlags(qs: readonly Question[], answers: Record<string, AnswerValue>): string[] {
  return qs.filter((q) => q.safetyWhen !== undefined && answers[q.key] === q.safetyWhen).map((q) => q.key);
}

export function missingRequired(qs: readonly Question[], answers: Record<string, AnswerValue>): string[] {
  return qs.filter((q) => q.required && answers[q.key] === undefined).map((q) => q.key);
}

// ---- media rules (PRD §110: low-data caps) ----------------------------------------------------------------
export type MediaKind = "photo" | "video" | "document";
export const MEDIA_RULES: Record<MediaKind, { mimes: Record<string, string>; maxBytes: number }> = {
  photo: { mimes: { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic", "image/heif": "heif" }, maxBytes: 10 * 1024 * 1024 },
  video: { mimes: { "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm" }, maxBytes: 100 * 1024 * 1024 },
  document: { mimes: { "application/pdf": "pdf" }, maxBytes: 15 * 1024 * 1024 },
};
