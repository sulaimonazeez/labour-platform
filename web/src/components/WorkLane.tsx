import { Link } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { useLoad } from "../lib/useLoad";
import { Skeleton } from "./ui";

// PRD §142: a provider's home leads with invitations, schedule, active work and money. Customers never see this lane's noise:
// without a provider profile it is one invitation to offer skills.
export function WorkLane() {
  const me = useLoad(async () => {
    try {
      await api("GET", "/providers/me");
      return { provider: true };
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return { provider: false };
      throw e;
    }
  });

  if (me.error) return null; // the lane is a convenience; never block the home screen on it
  if (me.loading && !me.data) return <Skeleton className="h-24" />;

  const tile = "rounded-2xl border border-line bg-surface p-4 transition hover:-translate-y-0.5 hover:border-brand/40 hover:shadow-lg hover:shadow-brand/10 active:scale-[0.98]";
  return (
    <section aria-label="If you do the work" className="space-y-3">
      <h2 className="text-xl font-semibold">If you do the work</h2>
      {me.data?.provider ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <Link to="/profile" className={tile}><span className="block font-semibold">Invitations and jobs</span><span className="text-sm text-ink/60">Accept work and see who invited you</span></Link>
          <Link to="/schedule" className={tile}><span className="block font-semibold">My schedule</span><span className="text-sm text-ink/60">Bookings and the hours you work</span></Link>
          <Link to="/earnings" className={tile}><span className="block font-semibold">Earnings</span><span className="text-sm text-ink/60">What you have earned and your payouts</span></Link>
        </div>
      ) : (
        <div className="rounded-2xl border border-dashed border-line p-5">
          <p className="font-semibold">Offer your skills</p>
          <p className="mt-1 text-sm text-ink/70">Create a provider profile and pick your trades. Customers can then find you and invite you to quote.</p>
          <Link to="/profile" className="mt-3 inline-flex rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-onbrand transition hover:opacity-90 active:scale-[0.97]">Set up my provider profile</Link>
        </div>
      )}
    </section>
  );
}
