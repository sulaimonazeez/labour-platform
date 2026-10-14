// The plug-in seam for everything intelligent (PRD §20, §105-108, §149).
// Core workflows never import a vendor: they call `getAi()`, `getTranslator()`, `getSpeech()`.
// Choose adapters with env vars; with none set the platform runs fully, deterministically, with no AI (PRD §16, §20).
//   AI_PROVIDER=none|mock|anthropic          (default none)
//   TRANSLATION_PROVIDER=none|mock|ai        (default none; "ai" routes through AI_PROVIDER)
//   SPEECH_PROVIDER=none|mock                (default none; add a real adapter here)
// To plug a new vendor: implement the interface, add one `case` below. Nothing else changes.

export type AiPurpose =
  | "classify" | "questions" | "scope_draft" | "quote_compare" | "change_impact" | "brief"
  | "dispute_summary" | "assistant_answer" | "translate" | "transcribe";

export type AiRequest = {
  purpose: AiPurpose;
  system: string;
  prompt: string;
  maxTokens?: number;
  /** Structured data the caller already computed. Real models may ignore it; the mock adapter echoes `fallback`. */
  context?: Record<string, unknown>;
};
export type AiResponse = { text: string; model: string; inputTokens?: number; outputTokens?: number };

export interface AiProvider {
  readonly name: string;
  available(): boolean;
  complete(req: AiRequest): Promise<AiResponse>;
}

/** Thrown when AI is off, over quota, or failed. Callers MUST catch it and continue deterministically (PRD §20). */
export class AiUnavailable extends Error {
  reason: "disabled" | "quota" | "flag" | "error";
  constructor(reason: "disabled" | "quota" | "flag" | "error", message: string) {
    super(message);
    this.name = "AiUnavailable";
    this.reason = reason;
  }
}

const noneAi: AiProvider = {
  name: "none",
  available: () => false,
  complete: async () => { throw new AiUnavailable("disabled", "AI is not enabled on this deployment"); },
};

/** Deterministic stand-in for tests and demos. It never calls a network; it returns what the caller computed. */
const mockAi: AiProvider = {
  name: "mock",
  available: () => true,
  complete: async (req) => {
    const ctx = req.context ?? {};
    if (req.purpose === "translate") {
      return { text: `[${String(ctx.to ?? "??")}] ${String(ctx.text ?? "")}`, model: "mock-1", inputTokens: 0, outputTokens: 0 };
    }
    const fallback = ctx.fallback;
    return { text: typeof fallback === "string" ? fallback : JSON.stringify(fallback ?? {}), model: "mock-1", inputTokens: 0, outputTokens: 0 };
  },
};

class AnthropicAi implements AiProvider {
  readonly name = "anthropic";
  available() { return Boolean(process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_MODEL); }
  async complete(req: AiRequest): Promise<AiResponse> {
    const key = process.env.ANTHROPIC_API_KEY;
    const model = process.env.ANTHROPIC_MODEL;
    if (!key || !model) throw new AiUnavailable("disabled", "ANTHROPIC_API_KEY and ANTHROPIC_MODEL must both be set");
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: req.maxTokens ?? 1500, system: req.system, messages: [{ role: "user", content: req.prompt }] }),
      signal: AbortSignal.timeout(Number(process.env.AI_TIMEOUT_MS ?? 15000)),
    });
    if (!res.ok) throw new Error(`anthropic responded ${res.status}`);
    const j = (await res.json()) as { model?: string; content?: { type: string; text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number } };
    const text = (j.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
    return { text, model: j.model ?? model, inputTokens: j.usage?.input_tokens, outputTokens: j.usage?.output_tokens };
  }
}

export function getAi(): AiProvider {
  switch ((process.env.AI_PROVIDER ?? "none").toLowerCase()) {
    case "mock": return mockAi;
    case "anthropic": return new AnthropicAi();
    default: return noneAi;
  }
}

// ── Translation (PRD §25-30) ─────────────────────────────────────────────────
export type Translation = { text: string; provider: string; model: string | null; confidence: number | null };
export interface TranslationProvider {
  readonly name: string;
  available(): boolean;
  /** `via: "ai"` providers are executed by i18n/translate.ts through the governed AI path (quota + logging). */
  readonly via: "direct" | "ai";
  translate(input: { text: string; from: string | null; to: string }): Promise<Translation>;
}

const noneTranslator: TranslationProvider = {
  name: "none", via: "direct",
  available: () => false,
  translate: async () => { throw new AiUnavailable("disabled", "Translation is not enabled on this deployment"); },
};
const mockTranslator: TranslationProvider = {
  name: "mock", via: "direct",
  available: () => true,
  translate: async ({ text, to }) => ({ text: `[${to}] ${text}`, provider: "mock", model: "mock-1", confidence: 0.5 }),
};
const aiTranslator: TranslationProvider = {
  name: "ai", via: "ai",
  available: () => getAi().available(),
  translate: async () => { throw new AiUnavailable("error", "the ai translator runs through i18n/translate.ts"); },
};

export function getTranslator(): TranslationProvider {
  switch ((process.env.TRANSLATION_PROVIDER ?? "none").toLowerCase()) {
    case "mock": return mockTranslator;
    case "ai": return aiTranslator;
    default: return noneTranslator;
  }
}

// ── Speech (PRD §35) ─────────────────────────────────────────────────────────
export type Transcript = { text: string; language: string | null; provider: string; model: string | null; confidence: number | null };
export interface SpeechProvider {
  readonly name: string;
  available(): boolean;
  transcribe(input: { storagePath: string; mimeType: string; languageHint: string | null }): Promise<Transcript>;
}
const noneSpeech: SpeechProvider = {
  name: "none",
  available: () => false,
  transcribe: async () => { throw new AiUnavailable("disabled", "Voice transcription is not enabled on this deployment"); },
};
const mockSpeech: SpeechProvider = {
  name: "mock",
  available: () => true,
  transcribe: async ({ languageHint }) => ({ text: "[mock transcript]", language: languageHint, provider: "mock", model: "mock-1", confidence: 0.5 }),
};
export function getSpeech(): SpeechProvider {
  return (process.env.SPEECH_PROVIDER ?? "none").toLowerCase() === "mock" ? mockSpeech : noneSpeech;
}

// ── Other adapters the PRD names (PRD §125, §148). Interfaces only: nothing calls a vendor until one is plugged in. ──
export interface IdentityVerifier {
  readonly name: string;
  verify(input: { userId: string; verificationClass: string; marketCode: string; documentRef: string | null }): Promise<{ status: "verified" | "rejected" | "pending"; issuer: string | null }>;
}
export const manualIdentityVerifier: IdentityVerifier = {
  name: "manual",
  // Without a country adapter, a verification stays pending until a platform admin decides (PRD §88).
  verify: async () => ({ status: "pending", issuer: null }),
};
