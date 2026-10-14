import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Button, EmptyState, Note, Pill, Skeleton } from "../components/ui";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { formatMoney, toMinor } from "../lib/money";
import { useToast } from "../lib/toast";
import type { Market, PayoutAccount } from "../lib/types";
import { useLoad } from "../lib/useLoad";

// PRD §50: earnings are never one ambiguous balance. Available, in transit and paid out are shown separately.
type Balance = { currency: string; availableMinor: number; inTransitMinor: number; paidOutMinor: number };
type BalanceRes = { balance: Balance; minimumPayoutMinor: number };
type PayoutRow = { id: string; amountMinor: number; currency: string; state: string; failureReason: string | null; createdAt: string };
type Bank = { name: string; code: string };

const STATE_TEXT: Record<string, string> = {
  pending: "Waiting for approval", processing: "Being sent", paid: "Paid", failed: "Failed", cancelled: "Cancelled",
};

const notFound = (e: unknown) => e instanceof ApiError && e.status === 404;
const input = "mt-1 w-full rounded-xl border border-line bg-surface px-3 py-2.5 text-base";

export default function Earnings() {
  const { user } = useAuth();
  const toast = useToast();

  const ref = useLoad(() => api<{ markets: Market[] }>("GET", "/reference"));
  const market = ref.data?.markets.find((m) => m.id === user?.marketId) ?? ref.data?.markets[0];
  const currencies = market?.currencies ?? [];

  const balances = useLoad(async () => {
    if (currencies.length === 0) return { provider: true, items: [] as BalanceRes[] };
    try {
      return { provider: true, items: await Promise.all(currencies.map((c) => api<BalanceRes>("GET", `/providers/me/balance?currency=${c}`))) };
    } catch (e) {
      if (notFound(e)) return { provider: false, items: [] as BalanceRes[] };
      throw e;
    }
  }, [currencies.join(",")]);
  const account = useLoad(() => api<{ payoutAccount: PayoutAccount }>("GET", "/providers/me/payout-account").then((r) => r.payoutAccount).catch((e) => { if (notFound(e)) return null; throw e; }));
  const payouts = useLoad(() => api<{ payouts: PayoutRow[] }>("GET", "/providers/me/payouts").catch((e) => { if (notFound(e)) return { payouts: [] as PayoutRow[] }; throw e; }));

  const [cur, setCur] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [acctOpen, setAcctOpen] = useState(false);
  const [banks, setBanks] = useState<Bank[] | null>(null);
  const [bankCode, setBankCode] = useState("");
  const [acctNo, setAcctNo] = useState("");
  const [amount, setAmount] = useState("");

  const items = balances.data?.items ?? [];
  const chosen = cur ?? currencies[0] ?? "";
  const current = items.find((i) => i.balance.currency === chosen);
  const minimum = current?.minimumPayoutMinor ?? 0;

  function refresh() { balances.reload(); account.reload(); payouts.reload(); }

  async function run(key: string, fn: () => Promise<string | void>) {
    setBusy(key);
    setError(null);
    try {
      const msg = await fn();
      if (msg) toast.success(msg);
      refresh();
    } catch (e) {
      const m = e instanceof Error ? e.message : "Something went wrong";
      setError(m);
      toast.error(m);
    } finally {
      setBusy(null);
    }
  }

  async function openAccountForm() {
    setAcctOpen((o) => !o);
    setError(null);
    if (banks === null) {
      try {
        const r = await api<{ banks: Bank[] }>("GET", `/providers/banks?currency=${chosen}`);
        setBanks(r.banks);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not load the bank list");
      }
    }
  }

  function saveAccount(e: FormEvent) {
    e.preventDefault();
    void run("account", async () => {
      const r = await api<{ payoutAccount: PayoutAccount }>("PUT", "/providers/me/payout-account", { bankCode, accountNumber: acctNo.trim(), currency: chosen });
      setAcctOpen(false);
      setAcctNo("");
      return `Account found: ${r.payoutAccount.accountName}`;
    });
  }

  function requestPayout(e: FormEvent) {
    e.preventDefault();
    const minor = toMinor(amount, chosen);
    if (!minor || minor <= 0) { setError("Enter an amount greater than zero."); return; }
    void run("payout", async () => {
      await api("POST", "/providers/me/payouts", { amountMinor: minor, currency: chosen });
      setAmount("");
      return "Payout requested. It is sent once it is approved.";
    });
  }

  if (balances.loading && !balances.data) return <div className="space-y-4"><Skeleton className="h-32" /><Skeleton className="h-24" /></div>;
  if (balances.error) return <Note>{balances.error}</Note>;
  if (balances.data && !balances.data.provider) {
    return (
      <div className="space-y-4">
        <h1 className="text-3xl font-bold">Earnings</h1>
        <EmptyState title="Earnings are for providers" hint="Create a provider profile first. Money released from approved stages appears here." />
        <Link to="/profile" className="text-sm font-semibold text-brand underline">Go to your profile</Link>
      </div>
    );
  }

  const bankName = (code: string) => banks?.find((b) => b.code === code)?.name;

  return (
    <div className="space-y-8">
      <h1 className="text-3xl font-bold">Earnings</h1>
      {error && <Note>{error}</Note>}

      {currencies.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {currencies.map((c) => (
            <button key={c} type="button" onClick={() => setCur(c)} aria-pressed={chosen === c}
              className={`rounded-full px-3.5 py-1.5 text-sm font-semibold ${chosen === c ? "bg-brand text-onbrand" : "border border-line bg-surface text-ink/70"}`}>{c}</button>
          ))}
        </div>
      )}

      <section className="adire rounded-3xl p-6 text-white md:p-8">
        <p className="text-sm text-white/70">Available to withdraw</p>
        <p className="mt-1 text-4xl font-bold md:text-5xl">{formatMoney(current?.balance.availableMinor ?? 0, chosen)}</p>
        <dl className="mt-6 grid grid-cols-2 gap-4 text-sm">
          <div><dt className="text-white/65">On its way to your bank</dt><dd className="mt-0.5 text-lg font-semibold">{formatMoney(current?.balance.inTransitMinor ?? 0, chosen)}</dd></div>
          <div><dt className="text-white/65">Paid out so far</dt><dd className="mt-0.5 text-lg font-semibold">{formatMoney(current?.balance.paidOutMinor ?? 0, chosen)}</dd></div>
        </dl>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Where we pay you</h2>
        {account.loading && !account.data ? <Skeleton className="h-20" /> : account.data ? (
          <div className="rise flex items-center justify-between gap-3 rounded-2xl border border-line bg-surface p-4">
            <div className="min-w-0">
              <p className="font-semibold">{account.data.accountName}</p>
              <p className="text-sm text-ink/60">{bankName(account.data.bankCode) ?? `Bank ${account.data.bankCode}`} · ending {account.data.accountLast4}</p>
            </div>
            <Button variant="quiet" onClick={openAccountForm}>{acctOpen ? "Close" : "Change"}</Button>
          </div>
        ) : (
          <EmptyState title="No payout account yet" hint="Add the bank account where your earnings should be sent." />
        )}
        {!account.data && !acctOpen && <Button onClick={openAccountForm}>Add bank account</Button>}

        {acctOpen && (
          <form onSubmit={saveAccount} className="rise space-y-3 rounded-2xl border border-gold/60 bg-gold/10 p-4">
            <label className="block text-sm font-medium">Bank
              <select value={bankCode} onChange={(e) => setBankCode(e.target.value)} required className={input}>
                <option value="">{banks === null ? "Loading banks" : "Choose your bank"}</option>
                {(banks ?? []).map((b) => <option key={b.code} value={b.code}>{b.name}</option>)}
              </select>
            </label>
            <label className="block text-sm font-medium">Account number
              <input value={acctNo} onChange={(e) => setAcctNo(e.target.value.replace(/\D/g, ""))} required inputMode="numeric" minLength={6} maxLength={20} className={input} />
            </label>
            <p className="text-sm text-ink/70">We check the account with the bank and show you the name on it. We keep only the last 4 digits.</p>
            <Button type="submit" variant="gold" busy={busy === "account"} disabled={busy !== null || !bankCode || acctNo.length < 6}>Check and save</Button>
          </form>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Withdraw</h2>
        {!account.data ? (
          <Note tone="info">Add a bank account first.</Note>
        ) : (
          <form onSubmit={requestPayout} className="space-y-3 rounded-2xl border border-line bg-surface p-4">
            <label className="block text-sm font-medium">Amount ({chosen})
              <input value={amount} onChange={(e) => setAmount(e.target.value)} required inputMode="decimal" placeholder="0.00" className={input} />
            </label>
            {minimum > 0 && <p className="text-sm text-ink/60">Smallest payout: {formatMoney(minimum, chosen)}. Each payout is approved before money is sent.</p>}
            <Button type="submit" busy={busy === "payout"} disabled={busy !== null || !amount.trim() || (current?.balance.availableMinor ?? 0) <= 0}>Request payout</Button>
          </form>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Payout history</h2>
        {payouts.loading && !payouts.data ? <Skeleton className="h-16" /> : (payouts.data?.payouts.length ?? 0) === 0 ? (
          <p className="text-ink/60">No payouts yet.</p>
        ) : (
          <ul className="space-y-2">
            {payouts.data!.payouts.map((p) => (
              <li key={p.id} className="rise rounded-2xl border border-line bg-surface p-4">
                <div className="flex items-center justify-between gap-3">
                  <p className="font-semibold">{formatMoney(p.amountMinor, p.currency)}</p>
                  <Pill value={p.state} />
                </div>
                <p className="mt-1 text-sm text-ink/60">{STATE_TEXT[p.state] ?? p.state} · {new Date(p.createdAt).toLocaleDateString()}</p>
                {p.state === "failed" && p.failureReason && <p className="mt-1 text-sm text-alarm">{p.failureReason}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
