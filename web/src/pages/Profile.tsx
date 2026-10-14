import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Avatar } from "../components/ProviderCard";
import { QuoteForm } from "../components/QuoteForm";
import { ServicesEditor, TradePicker } from "../components/ServicesEditor";
import { TaskThread } from "../components/TaskThread";
import { ClockIcon, GlobeIcon, PinIcon, ShieldIcon, SparkIcon, WalletIcon } from "../components/Icons";
import { Button, EmptyState, Note, Pill, Skeleton } from "../components/ui";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useInView, useCountUp } from "../lib/motion";
import { useTheme } from "../lib/theme";
import { useToast } from "../lib/toast";
import type { AssignmentRow, Invitation, Market, PayoutAccount, ProjectRow, ProviderProfile, RequestRow, User } from "../lib/types";
import { useLoad } from "../lib/useLoad";

function langName(code: string): string {
  try { return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code; } catch { return code; }
}

/** Money from minor units. The number of decimals comes from the currency itself, never assumed. */
function money(minor: number, currency: string): string {
  try {
    const nf = new Intl.NumberFormat(undefined, { style: "currency", currency });
    return nf.format(minor / 10 ** (nf.resolvedOptions().maximumFractionDigits ?? 2));
  } catch { return `${minor} ${currency}`; }
}

function LocalTime({ zone }: { zone: string }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const id = window.setInterval(() => setNow(new Date()), 30_000); return () => window.clearInterval(id); }, []);
  try { return <>{now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZone: zone })}</>; } catch { return <>{zone}</>; }
}

function Stat({ label, value, ready }: { label: string; value: number; ready: boolean }) {
  const [ref, seen] = useInView<HTMLDivElement>();
  const n = useCountUp(value, seen && ready);
  return (
    <div ref={ref} className="rounded-2xl bg-white/10 px-4 py-3">
      <p className="text-3xl font-bold tabular-nums">{ready ? n : "·"}</p>
      <p className="text-xs text-white/70">{label}</p>
    </div>
  );
}

function Switch({ on, onChange, label }: { on: boolean; onChange: () => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={onChange} className={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${on ? "bg-brand" : "bg-line"}`}>
      <span className={`absolute left-0.5 top-0.5 h-6 w-6 rounded-full bg-white shadow transition-transform duration-300 ${on ? "translate-x-5" : ""}`} />
    </button>
  );
}

const card = "rounded-2xl border border-line bg-surface p-5";

export default function Profile() {
  const { user, signOut } = useAuth();
  const { theme, toggle } = useTheme();
  const me = useLoad(() => api<{ user: User }>("GET", "/me"));
  const markets = useLoad(() => api<{ markets: Market[] }>("GET", "/reference"));
  const requests = useLoad(() => api<{ requests: RequestRow[] }>("GET", "/requests"));
  const projects = useLoad(() => api<{ projects: ProjectRow[] }>("GET", "/projects"));
  const provider = useLoad(() =>
    api<{ provider: ProviderProfile | null }>("GET", "/providers/me").catch((e) => {
      if (e instanceof ApiError && e.status === 404) return { provider: null };
      throw e;
    }),
  );

  const u = me.data?.user ?? user;
  if (!u) return <Skeleton className="h-40" />;
  const market = markets.data?.markets.find((m) => m.id === u.marketId);
  const secondary = (u.secondaryLanguages ?? []).map(langName);

  return (
    <div className="space-y-6">
      <header className="adire relative overflow-hidden rounded-3xl p-6 text-white md:p-8">
        <div aria-hidden className="glow-orb pointer-events-none absolute -right-20 -top-20 h-56 w-56 rounded-full" />
        <div className="relative flex items-center gap-4">
          <Avatar name={u.displayName} size="h-16 w-16" text="text-xl" />
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-bold md:text-3xl">{u.displayName}</h1>
            {u.email && <p className="truncate text-sm text-white/75">{u.email}</p>}
            <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-white/70">
              {market && <span className="inline-flex items-center gap-1"><PinIcon className="h-3.5 w-3.5" />{market.name}</span>}
              <span className="inline-flex items-center gap-1"><ClockIcon className="h-3.5 w-3.5" /><LocalTime zone={u.timezone} /> · {u.timezone}</span>
            </p>
          </div>
        </div>
        <div className="relative mt-5 grid grid-cols-2 gap-3">
          <Stat label="Requests posted" value={requests.data?.requests.length ?? 0} ready={!!requests.data} />
          <Stat label="Projects" value={projects.data?.projects.length ?? 0} ready={!!projects.data} />
        </div>
      </header>

      {me.error && <Note>{me.error}</Note>}

      <section className={card}>
        <h2 className="flex items-center gap-2 text-lg font-semibold"><GlobeIcon className="h-5 w-5 text-brand" /> Language and region</h2>
        <dl className="mt-3 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <div><dt className="text-ink/60">Preferred language</dt><dd className="font-semibold">{langName(u.preferredLanguage)}</dd></div>
          <div><dt className="text-ink/60">Other languages</dt><dd className="font-semibold">{secondary.length ? secondary.join(", ") : "None added"}</dd></div>
          <div><dt className="text-ink/60">Translate messages for me</dt><dd className="font-semibold">{u.autoTranslate === undefined || u.autoTranslate === null ? "Not set" : u.autoTranslate ? "Yes" : "No"}</dd></div>
          <div><dt className="text-ink/60">Show original text</dt><dd className="font-semibold">{u.showOriginalByDefault === undefined || u.showOriginalByDefault === null ? "Not set" : u.showOriginalByDefault ? "Always" : "On request"}</dd></div>
        </dl>
        <p className="mt-3 text-xs text-ink/50">These settings cannot be edited from the app yet.</p>
      </section>

      {provider.error && <Note>{provider.error}</Note>}
      {provider.loading && !provider.data ? (
        <Skeleton className="h-40" />
      ) : provider.data?.provider ? (
        <>
          <a href="/earnings" className="mb-4 inline-flex rounded-xl border border-line bg-surface px-4 py-2.5 text-sm font-semibold text-brand hover:bg-brand/5">Earnings and payouts</a>
          <ProviderPanel p={provider.data.provider} />
        </>
      ) : (
        <BecomeProvider onCreated={provider.reload} />
      )}

      <section className={card}>
        <h2 className="text-lg font-semibold">Appearance</h2>
        <div className="mt-3 flex items-center justify-between gap-4">
          <p className="text-sm text-ink/70">Dark theme</p>
          <Switch on={theme === "dark"} onChange={toggle} label="Dark theme" />
        </div>
      </section>

      <Button variant="quiet" className="w-full" onClick={() => void signOut()}>Sign out</Button>
    </div>
  );
}

function BecomeProvider({ onCreated }: { onCreated: () => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<"individual" | "company">("individual");
  const [headline, setHeadline] = useState("");
  const [bio, setBio] = useState("");
  const [remoteOk, setRemoteOk] = useState(false);
  const [trades, setTrades] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("POST", "/providers/me", {
        kind, remoteOk,
        ...(headline.trim() ? { headline: headline.trim() } : {}),
        ...(bio.trim() ? { bio: bio.trim() } : {}),
      });
      if (trades.length > 0) await api("PUT", "/providers/me/services", { categories: trades });
      toast.success("Your provider profile is live");
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the profile");
    } finally {
      setBusy(false);
    }
  }

  const field = "w-full rounded-xl border border-line bg-surface px-3 py-2.5 text-base focus:border-brand";
  return (
    <section className="rounded-2xl border border-gold/60 bg-gold/10 p-5">
      <h2 className="flex items-center gap-2 text-lg font-semibold"><SparkIcon className="h-5 w-5 text-caution" /> Do the work, get paid</h2>
      <p className="mt-1 text-sm text-ink/70">Create a provider profile to be found, invited to quote and paid as each stage is approved.</p>
      {!open ? (
        <Button variant="gold" className="mt-4" onClick={() => setOpen(true)}>Set up my provider profile</Button>
      ) : (
        <form onSubmit={submit} className="rise mt-4 space-y-4">
          <div role="radiogroup" aria-label="I work as" className="grid grid-cols-2 gap-2">
            {(["individual", "company"] as const).map((k) => (
              <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => setKind(k)}
                className={`rounded-xl border px-3 py-2.5 text-sm font-semibold transition ${kind === k ? "border-brand bg-brand text-onbrand" : "border-line bg-surface"}`}>
                {k === "individual" ? "Individual" : "Company"}
              </button>
            ))}
          </div>
          <div><span className="mb-1 block text-sm font-medium">What do you do?</span><TradePicker value={trades} onChange={setTrades} /></div>
          <label className="block"><span className="mb-1 block text-sm font-medium">Headline</span>
            <input className={field} value={headline} maxLength={200} onChange={(e) => setHeadline(e.target.value)} placeholder="Licensed electrician, 8 years experience" />
          </label>
          <label className="block"><span className="mb-1 block text-sm font-medium">About you</span>
            <textarea className={field} rows={4} value={bio} maxLength={3000} onChange={(e) => setBio(e.target.value)} placeholder="What you do, where you work, what you are proud of" />
          </label>
          <label className="flex items-center gap-3 text-sm"><input type="checkbox" checked={remoteOk} onChange={(e) => setRemoteOk(e.target.checked)} className="h-5 w-5 accent-[rgb(var(--brand))]" /> I can also work remotely</label>
          {error && <Note>{error}</Note>}
          <div className="flex gap-2">
            <Button type="submit" variant="gold" busy={busy}>Create profile</Button>
            <Button type="button" variant="quiet" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
          </div>
        </form>
      )}
    </section>
  );
}

function ProviderPanel({ p }: { p: ProviderProfile }) {
  const toast = useToast();
  const invites = useLoad(() => api<{ invitations: Invitation[] }>("GET", "/providers/me/invitations"));
  const assigns = useLoad(() => api<{ assignments: AssignmentRow[] }>("GET", "/assignments"));
  const payout = useLoad(() =>
    api<{ payoutAccount: PayoutAccount | null }>("GET", "/providers/me/payout-account").catch((e) => {
      if (e instanceof ApiError && e.status === 404) return { payoutAccount: null };
      throw e;
    }),
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [openInv, setOpenInv] = useState<string | null>(null);

  async function submitDraft(quoteId: string) {
    setBusy(`draft:${quoteId}`);
    try {
      await api("POST", `/quotes/${quoteId}/submit`, {});
      toast.success("Quote sent");
      invites.reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not send the quote");
    } finally {
      setBusy(null);
    }
  }

  async function respond(a: AssignmentRow, action: "accept" | "reject") {
    setBusy(`${a.id}:${action}`);
    try {
      await api("POST", `/assignments/${a.id}/${action}`, {});
      toast.success(action === "accept" ? "Job accepted" : "Job declined");
      assigns.reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not respond");
    } finally {
      setBusy(null);
    }
  }

  const inv = invites.data?.invitations ?? [];
  const asg = assigns.data?.assignments ?? [];
  const waiting = inv.filter((i) => i.quoteId === null).length;
  const offered = asg.filter((a) => a.status === "offered").length;

  return (
    <section className={`${card} space-y-5`}>
      <div className="flex items-start gap-3">
        <Avatar name={p.displayName} size="h-12 w-12" />
        <div className="min-w-0 flex-1">
          <h2 className="flex flex-wrap items-center gap-2 text-lg font-semibold leading-tight">{p.displayName}
            <span className="rounded-full bg-brand/10 px-2 py-0.5 text-xs font-semibold text-brand">{p.kind === "company" ? "Company" : "Individual"}</span>
            {p.remoteOk && <span className="rounded-full bg-signal/15 px-2 py-0.5 text-xs font-semibold text-signal">Remote OK</span>}
          </h2>
          <p className="mt-0.5 text-sm text-ink/70">{p.headline ?? "Add a headline so people know what you do."}</p>
        </div>
      </div>
      {p.bio && <p className="whitespace-pre-line text-sm text-ink/80">{p.bio}</p>}

      <div className="grid grid-cols-2 gap-3 text-center">
        <div className="rounded-xl bg-brand/5 p-3"><p className="text-2xl font-bold tabular-nums">{invites.data ? waiting : "·"}</p><p className="text-xs text-ink/60">Waiting for your quote</p></div>
        <div className="rounded-xl bg-brand/5 p-3"><p className="text-2xl font-bold tabular-nums">{assigns.data ? offered : "·"}</p><p className="text-xs text-ink/60">Jobs awaiting your answer</p></div>
      </div>

      <div>
        <h3 className="font-semibold">Jobs offered to you</h3>
        {assigns.error && <div className="mt-2"><Note>{assigns.error}</Note></div>}
        {assigns.loading && !assigns.data ? <Skeleton className="mt-2 h-16" /> : asg.length === 0 ? (
          <p className="mt-2 text-sm text-ink/60">Nothing yet. When a customer accepts your quote, the job shows up here.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {asg.slice(0, 6).map((a) => (
              <li key={a.id} className="rounded-xl border border-line p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0"><p className="truncate font-medium">{a.task.title}</p><p className="truncate text-xs text-ink/60">{a.project.title}</p></div>
                  <Pill value={a.status} />
                </div>
                {a.agreedTotalMinor !== null && a.agreedCurrency && <p className="mt-1 text-sm font-semibold">{money(a.agreedTotalMinor, a.agreedCurrency)}</p>}
                {a.status === "offered" && (
                  <div className="mt-2 flex gap-2">
                    <Button variant="gold" busy={busy === `${a.id}:accept`} disabled={busy !== null} onClick={() => void respond(a, "accept")}>Accept</Button>
                    <Button variant="quiet" busy={busy === `${a.id}:reject`} disabled={busy !== null} onClick={() => void respond(a, "reject")}>Decline</Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <ServicesEditor />

      <div>
        <h3 className="font-semibold">Invitations to quote</h3>
        {invites.error && <div className="mt-2"><Note>{invites.error}</Note></div>}
        {invites.loading && !invites.data ? <Skeleton className="mt-2 h-16" /> : inv.length === 0 ? (
          <div className="mt-2"><EmptyState title="No invitations yet" hint="When a project owner invites you to quote, it appears here." /></div>
        ) : (
          <ul className="mt-2 space-y-2">
            {inv.slice(0, 6).map((i) => {
              const isOpen = openInv === i.taskId;
              return (
                <li key={`${i.taskId}`} className="rounded-xl border border-line p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0"><p className="truncate font-medium">{i.taskTitle}</p><p className="truncate text-xs text-ink/60">{i.projectTitle}</p></div>
                    <div className="flex shrink-0 flex-col items-end gap-1"><Pill value={i.status} />{i.quoteStatus && <span className="text-[11px] text-ink/60">Quote {i.quoteStatus.replaceAll("_", " ")}</span>}</div>
                  </div>
                  {i.taskDescription && i.taskDescription !== i.taskTitle && <p className="mt-2 text-sm text-ink/70">{i.taskDescription}</p>}
                  <button type="button" aria-expanded={isOpen} onClick={() => setOpenInv(isOpen ? null : i.taskId)}
                    className="mt-2 rounded-xl border border-line px-3 py-1.5 text-sm font-semibold hover:bg-brand/5">{isOpen ? "Close" : i.quoteId ? "Open" : "Quote or message"}</button>
                  {isOpen && (
                    <div className="mt-3 space-y-3">
                      <TaskThread taskId={i.taskId} />
                      {!i.quoteId && i.taskStatus === "offered" && <QuoteForm taskId={i.taskId} currency={i.projectCurrency} onSent={invites.reload} />}
                      {i.quoteStatus === "draft" && i.quoteId && (
                        <Button busy={busy === `draft:${i.quoteId}`} disabled={busy !== null} onClick={() => void submitDraft(i.quoteId!)}>Send my draft quote</Button>
                      )}
                      {!i.quoteId && i.taskStatus !== "offered" && <p className="text-sm text-ink/60">This task is no longer open for quotes.</p>}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="flex items-start gap-3 rounded-xl bg-brand/5 p-3 text-sm">
        <WalletIcon className="mt-0.5 h-5 w-5 shrink-0 text-brand" />
        <div>
          <p className="font-semibold">Payout account</p>
          {payout.loading && !payout.data ? <p className="text-ink/60">Checking</p> : payout.data?.payoutAccount ? (
            <p className="text-ink/70">{payout.data.payoutAccount.accountName} · ending {payout.data.payoutAccount.accountLast4} · {payout.data.payoutAccount.currency}</p>
          ) : (
            <p className="text-ink/70">Not set up. You will need one to be paid out. Setting it up is not in the app yet.</p>
          )}
        </div>
      </div>
      <p className="flex items-center gap-1.5 text-xs text-ink/50"><ShieldIcon className="h-3.5 w-3.5" /> Verification badges and a public profile page come with the verification work. <Link to="/find" className="font-semibold text-brand underline">See how people find you</Link></p>
    </section>
  );
}
