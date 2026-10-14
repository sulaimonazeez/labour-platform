import { useState } from "react";
import { Card, Stat, useRun } from "../components/kit";
import { Button, Note, Skeleton } from "../components/ui";
import { api } from "../lib/api";
import type { User } from "../lib/types";
import { useLoad } from "../lib/useLoad";

// PRD §26 (language and translation choice), §113 (channels, quiet hours), §131 (access and deletion), §147 (AI is optional).
type Lang = { code: string; nameNative: string; nameEnglish: string };
type Pref = { channel: string; kindPrefix: string; enabled: boolean; quietStart: string | null; quietEnd: string | null };
const CHANNELS = [["in_app", "In the app"], ["push", "Push"], ["email", "Email"], ["sms", "SMS"], ["messaging", "Messaging apps"]] as const;

export default function Settings() {
  const me = useLoad(() => api<{ user: User }>("GET", "/me"));
  const langs = useLoad(() => api<{ languages: Lang[] }>("GET", "/languages"));
  const prefs = useLoad(() => api<{ preferences: Pref[] }>("GET", "/me/notification-preferences"));
  const flags = useLoad(() => api<{ flags: Record<string, boolean> }>("GET", "/flags"));
  const ai = useLoad(() => api<{ ai: { provider: string; available: boolean; dailyLimit: number } }>("GET", "/ai/status"));
  const { busy, run } = useRun();
  const [lang, setLang] = useState<string | null>(null);
  const [second, setSecond] = useState<string[] | null>(null);
  const [auto, setAuto] = useState<boolean | null>(null);
  const [orig, setOrig] = useState<boolean | null>(null);
  const [tz, setTz] = useState<string | null>(null);
  const [off, setOff] = useState<Record<string, boolean>>({});
  const [qs, setQs] = useState<string | null>(null);
  const [qe, setQe] = useState<string | null>(null);

  const u = me.data?.user;
  if (me.loading && !u) return <Skeleton className="h-40" />;
  if (!u) return <Note>{me.error ?? "Could not load your account"}</Note>;
  const l = lang ?? u.preferredLanguage;
  const s2 = second ?? u.secondaryLanguages ?? [];
  const a = auto ?? u.autoTranslate ?? true;
  const o = orig ?? u.showOriginalByDefault ?? false;
  const tzv = tz ?? u.timezone;
  const prefOf = (ch: string) => prefs.data?.preferences.find((p) => p.channel === ch && p.kindPrefix === "");
  const enabled = (ch: string) => off[ch] ?? prefOf(ch)?.enabled ?? true;
  const quietStart = qs ?? prefs.data?.preferences.find((p) => p.quietStart)?.quietStart ?? "";
  const quietEnd = qe ?? prefs.data?.preferences.find((p) => p.quietEnd)?.quietEnd ?? "";
  const sel = "mt-1 w-full rounded-xl border border-line bg-surface px-3 py-2.5 font-normal";
  const sw = (on: boolean, set: (v: boolean) => void, label: string) => (
    <label className="flex items-center justify-between gap-4 text-sm"><span>{label}</span><input type="checkbox" checked={on} onChange={(e) => set(e.target.checked)} className="h-5 w-5 accent-[rgb(var(--brand))]" /></label>
  );

  return (
    <div className="space-y-5">
      <h1 className="text-3xl font-bold">Settings</h1>
      <Card title="Language and translation" hint="Your own language is used for what you read. Original messages are always kept.">
        <div className="space-y-3">
          <label className="block text-sm font-medium">I read in<select value={l} onChange={(e) => setLang(e.target.value)} className={sel}>{(langs.data?.languages ?? [{ code: l, nameNative: l, nameEnglish: l }]).map((x) => <option key={x.code} value={x.code}>{x.nameNative} ({x.nameEnglish})</option>)}</select></label>
          <fieldset><legend className="text-sm font-medium">I also understand</legend><div className="mt-1 flex flex-wrap gap-2">{(langs.data?.languages ?? []).filter((x) => x.code !== l).map((x) => { const on = s2.includes(x.code); return <button key={x.code} type="button" aria-pressed={on} onClick={() => setSecond(on ? s2.filter((c) => c !== x.code) : [...s2, x.code])} className={`rounded-full border px-3 py-1.5 text-sm ${on ? "border-brand bg-brand text-onbrand" : "border-line"}`}>{x.nameNative}</button>; })}</div></fieldset>
          {sw(a, setAuto, "Translate messages written in other languages for me")}
          {sw(o, setOrig, "Show the original text first")}
          <label className="block text-sm font-medium">Time zone<input value={tzv} onChange={(e) => setTz(e.target.value)} className={sel} placeholder="Africa/Lagos" /></label>
          <Button busy={busy === "lang"} onClick={() => void run("lang", () => api("PATCH", "/me/preferences", { preferredLanguage: l, secondaryLanguages: s2, autoTranslate: a, showOriginalByDefault: o, timezone: tzv }), "Saved", () => { me.reload(); })}>Save</Button>
        </div>
      </Card>

      <Card title="Notifications" hint="Quiet hours use your own time zone.">
        <div className="space-y-3">
          {CHANNELS.map(([ch, label]) => sw(enabled(ch), (v) => setOff({ ...off, [ch]: v }), label))}
          <div className="grid grid-cols-2 gap-3"><label className="block text-sm font-medium">Quiet from<input type="time" value={quietStart} onChange={(e) => setQs(e.target.value)} className={sel} /></label><label className="block text-sm font-medium">Until<input type="time" value={quietEnd} onChange={(e) => setQe(e.target.value)} className={sel} /></label></div>
          <Button busy={busy === "notif"} onClick={() => void run("notif", () => api("PUT", "/me/notification-preferences", { preferences: CHANNELS.map(([ch]) => ({ channel: ch, kindPrefix: "", enabled: enabled(ch), ...(quietStart && quietEnd ? { quietStart, quietEnd } : {}) })) }), "Saved", prefs.reload)}>Save</Button>
        </div>
      </Card>

      <Card title="Your data" hint="Download everything we hold about you, or ask us to delete your account. Records the law requires us to keep, such as financial records, are retained.">
        <div className="flex flex-wrap gap-2">
          <Button variant="quiet" busy={busy === "exp"} onClick={() => void run("exp", async () => {
            const r = await api<{ export: unknown }>("POST", "/me/privacy-requests", { kind: "export" });
            const url = URL.createObjectURL(new Blob([JSON.stringify(r.export, null, 2)], { type: "application/json" }));
            const link = document.createElement("a"); link.href = url; link.download = "my-data.json"; link.click(); URL.revokeObjectURL(url);
          }, "Your data was downloaded")}>Download my data</Button>
          <Button variant="quiet" busy={busy === "del"} onClick={() => { if (window.confirm("Ask us to delete your account? A person reviews this.")) void run("del", () => api("POST", "/me/privacy-requests", { kind: "delete" }), "Request received. A person will review it."); }}>Ask to delete my account</Button>
        </div>
      </Card>

      <Card title="Optional AI" hint="Everything works without it. When it is on, it only suggests and you decide.">
        {ai.data ? <div className="grid grid-cols-3 gap-2"><Stat label="Provider" value={ai.data.ai.provider} /><Stat label="Status" value={ai.data.ai.available ? "On" : "Off"} /><Stat label="Daily limit" value={ai.data.ai.dailyLimit} /></div> : <Skeleton className="h-16" />}
        {flags.data && <p className="mt-3 text-xs text-ink/60">Features on for you: {Object.entries(flags.data.flags).filter(([, v]) => v).map(([k]) => k).join(", ") || "none"}</p>}
      </Card>
    </div>
  );
}
