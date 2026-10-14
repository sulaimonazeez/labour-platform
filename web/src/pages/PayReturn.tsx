import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Button, Note, Spinner } from "../components/ui";
import { api } from "../lib/api";

// Where the gateway sends the customer back. The reference in the address finds the payment saved before leaving;
// we then ask our server, which asks the gateway. Nothing here decides that money arrived.
type View = "checking" | "secured" | "pending" | "failed" | "unknown";
type Saved = { paymentId: string; projectId: string };

function readSaved(reference: string): Saved | null {
  try {
    const raw = reference ? localStorage.getItem(`lp_pay_${reference}`) : null;
    return raw ? (JSON.parse(raw) as Saved) : null;
  } catch {
    return null;
  }
}

export default function PayReturn() {
  const [params] = useSearchParams();
  const reference = params.get("reference") ?? params.get("trxref") ?? "";
  const saved = readSaved(reference);
  const [view, setView] = useState<View>(saved ? "checking" : "unknown");
  const [error, setError] = useState<string | null>(null);
  const tries = useRef(0);

  async function check() {
    if (!saved) return;
    setView("checking");
    setError(null);
    try {
      const r = await api<{ outcome: string; payment: { state: string } }>("POST", `/payments/${saved.paymentId}/verify`, {});
      const s = r.payment.state;
      if (r.outcome === "secured" || ["secured", "partially_released", "released"].includes(s)) setView("secured");
      else if (r.outcome === "failed" || s === "failed") setView("failed");
      else setView("pending");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not check the payment");
      setView("pending");
    }
  }

  useEffect(() => { void check(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  // A card payment can take a few seconds to be confirmed: look again a few times before asking the person to.
  useEffect(() => {
    if (view !== "pending" || tries.current >= 6) return;
    const id = window.setTimeout(() => { tries.current += 1; void check(); }, 4000);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  const back = saved ? `/projects/${saved.projectId}` : "/projects";

  return (
    <div className="mx-auto max-w-md py-12 text-center">
      {view === "checking" && (
        <div className="space-y-4">
          <div className="mx-auto grid h-20 w-20 place-items-center rounded-full bg-brand/10 text-brand"><Spinner /></div>
          <h1 className="text-2xl font-bold">Checking your payment</h1>
          <p className="text-ink/70">This takes a moment. Please do not close this page.</p>
        </div>
      )}

      {view === "secured" && (
        <div className="space-y-4">
          <div className="lp-ring mx-auto grid h-24 w-24 place-items-center rounded-full bg-signal/15">
            <svg viewBox="0 0 24 24" className="h-12 w-12 text-signal" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path className="lp-draw" d="M5 12.5l4.5 4.5L19 7.5" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold">Payment received</h1>
          <p className="text-ink/70">This stage is funded. The provider can start, and you release the money when you approve the work.</p>
          <Link to={back}><Button variant="gold" className="mt-2">Back to the project</Button></Link>
        </div>
      )}

      {view === "pending" && (
        <div className="space-y-4">
          <div className="mx-auto grid h-20 w-20 place-items-center rounded-full bg-gold/20 text-gold"><Spinner /></div>
          <h1 className="text-2xl font-bold">Still waiting for the payment</h1>
          <p className="text-ink/70">If you have paid, it can take a short while to arrive. Nothing is lost.</p>
          {error && <Note>{error}</Note>}
          <div className="flex justify-center gap-2">
            <Button onClick={() => { tries.current = 0; void check(); }}>Check again</Button>
            <Link to={back}><Button variant="quiet">Back to the project</Button></Link>
          </div>
        </div>
      )}

      {view === "failed" && (
        <div className="space-y-4">
          <h1 className="text-2xl font-bold">The payment did not go through</h1>
          <p className="text-ink/70">You were not charged for this attempt. You can start the payment again from the project.</p>
          <Link to={back}><Button>Back to the project</Button></Link>
        </div>
      )}

      {view === "unknown" && (
        <div className="space-y-4">
          <h1 className="text-2xl font-bold">We could not find this payment on this device</h1>
          <p className="text-ink/70">Open the project and use "Check payment" on the stage. It will show the current state.</p>
          <Link to="/projects"><Button>Go to projects</Button></Link>
        </div>
      )}
    </div>
  );
}
