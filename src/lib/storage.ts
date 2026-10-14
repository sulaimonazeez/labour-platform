import { ApiError } from "../api/http";

// Private object storage behind an interface (PRD §132, §148: signed URLs for private media, no vendor lock-in).
//   STORAGE_DRIVER=supabase (default when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set) | memory (tests) | none
// The service-role key is a SERVER secret: it must never reach the browser. The bucket MUST be private.
// The Supabase calls follow the Storage REST API but were written without network access: verify with the
// live smoke test in docs/HANDOFF.md before trusting them (D40).

export type UploadTarget = { method: "PUT"; url: string; headers: Record<string, string>; expiresInSeconds: number };

export interface MediaStorage {
  createUpload(key: string, mimeType: string): Promise<UploadTarget>;
  head(key: string): Promise<{ sizeBytes: number } | null>;
  createDownloadUrl(key: string, ttlSeconds: number): Promise<string>;
  remove(key: string): Promise<void>;
}

const notConfigured = () => new ApiError(503, "storage_not_configured", "File storage is not configured on this server");

const none: MediaStorage = {
  createUpload: async () => { throw notConfigured(); },
  head: async () => { throw notConfigured(); },
  createDownloadUrl: async () => { throw notConfigured(); },
  remove: async () => { throw notConfigured(); },
};

class MemoryStorage implements MediaStorage {
  objects = new Map<string, number>();
  /** Test helper: pretend the device uploaded `sizeBytes` to this key. */
  simulateUpload(key: string, sizeBytes: number) { this.objects.set(key, sizeBytes); }
  has(key: string) { return this.objects.has(key); }
  async createUpload(key: string, mimeType: string): Promise<UploadTarget> {
    return { method: "PUT", url: `memory://upload/${key}`, headers: { "content-type": mimeType }, expiresInSeconds: 7200 };
  }
  async head(key: string) {
    const s = this.objects.get(key);
    return s === undefined ? null : { sizeBytes: s };
  }
  async createDownloadUrl(key: string, ttlSeconds: number) { return `memory://download/${key}?ttl=${ttlSeconds}`; }
  async remove(key: string) { this.objects.delete(key); }
}
export const memoryStorage = new MemoryStorage();

class SupabaseStorage implements MediaStorage {
  constructor(private base: string, private serviceKey: string, private bucket: string) {}
  private get api() { return `${this.base.replace(/\/+$/, "")}/storage/v1`; }
  private auth(extra: Record<string, string> = {}) {
    return { authorization: `Bearer ${this.serviceKey}`, apikey: this.serviceKey, ...extra };
  }
  async createUpload(key: string, mimeType: string): Promise<UploadTarget> {
    const res = await fetch(`${this.api}/object/upload/sign/${this.bucket}/${key}`, { method: "POST", headers: this.auth({ "content-type": "application/json" }), body: "{}" });
    if (!res.ok) throw new ApiError(502, "storage_error", `Storage refused to create an upload URL (${res.status})`);
    const j = (await res.json()) as { url?: string };
    if (!j.url) throw new ApiError(502, "storage_error", "Storage returned no upload URL");
    return { method: "PUT", url: `${this.api}${j.url}`, headers: { "content-type": mimeType }, expiresInSeconds: 7200 };
  }
  async head(key: string) {
    const res = await fetch(`${this.api}/object/authenticated/${this.bucket}/${key}`, { method: "HEAD", headers: this.auth() });
    if (res.status === 404 || res.status === 400) return null;
    if (!res.ok) throw new ApiError(502, "storage_error", `Storage lookup failed (${res.status})`);
    const len = Number(res.headers.get("content-length"));
    return { sizeBytes: Number.isFinite(len) ? len : 0 };
  }
  async createDownloadUrl(key: string, ttlSeconds: number) {
    const res = await fetch(`${this.api}/object/sign/${this.bucket}/${key}`, { method: "POST", headers: this.auth({ "content-type": "application/json" }), body: JSON.stringify({ expiresIn: ttlSeconds }) });
    if (!res.ok) throw new ApiError(502, "storage_error", `Storage refused to sign a download URL (${res.status})`);
    const j = (await res.json()) as { signedURL?: string };
    if (!j.signedURL) throw new ApiError(502, "storage_error", "Storage returned no download URL");
    return `${this.api}${j.signedURL}`;
  }
  async remove(key: string) {
    const res = await fetch(`${this.api}/object/${this.bucket}/${key}`, { method: "DELETE", headers: this.auth() });
    if (!res.ok && res.status !== 404) throw new ApiError(502, "storage_error", `Storage delete failed (${res.status})`);
  }
}

/** Resolved on every call so tests can switch driver through the environment. */
export function getStorage(): MediaStorage {
  const driver = process.env.STORAGE_DRIVER ?? (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY ? "supabase" : "none");
  if (driver === "memory") return memoryStorage;
  if (driver === "supabase" && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return new SupabaseStorage(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, process.env.STORAGE_BUCKET ?? "request-media");
  }
  return none;
}
