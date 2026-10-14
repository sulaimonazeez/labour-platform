import { Link } from "react-router-dom";
import { CategoryIcon, CompassIcon, LayersIcon, ShieldIcon, SparkIcon, UserIcon, WalletIcon, CameraIcon, GlobeIcon, ChatIcon, ClockIcon, WarnIcon } from "../components/Icons";
import type { ReactNode } from "react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useIsAdmin } from "../lib/useIsAdmin";
import { useLoad } from "../lib/useLoad";

// Grouped by what the person is trying to do (PRD §15: do not expose unnecessary complexity).
// Switched-off capabilities (feature flags, PRD §151) simply do not appear.
type Item = { to: string; title: string; hint: string; icon: ReactNode; flag?: string; admin?: boolean };
type Group = { title: string; blurb: string; items: Item[] };

const GROUPS: Group[] = [
  {
    title: "Get work done", blurb: "Plan it, buy what it needs, keep a record of what you own.",
    items: [
      { to: "/plan", title: "Plan a project", hint: "Describe an outcome, review a plan", icon: <SparkIcon /> },
      { to: "/shop", title: "Shop", hint: "Materials and equipment", icon: <WalletIcon />, flag: "commerce.enabled" },
      { to: "/assets", title: "Assets and warranties", hint: "What you own, service history, claims", icon: <LayersIcon /> },
      { to: "/templates", title: "Templates", hint: "Reusable, versioned processes", icon: <CameraIcon /> },
    ],
  },
  {
    title: "Do the work", blurb: "For providers: your time, your credentials, your money.",
    items: [
      { to: "/schedule", title: "Schedule", hint: "Bookings, your hours, repeating services", icon: <ClockIcon /> },
      { to: "/earnings", title: "Earnings", hint: "What you have earned and your payouts", icon: <WalletIcon /> },
      { to: "/trust", title: "Trust and credentials", hint: "Verification, insurance, teams", icon: <ShieldIcon /> },
      { to: "/merchant", title: "Sell products", hint: "Your shop, orders and quotes", icon: <CategoryIcon id="plug" />, flag: "commerce.enabled" },
    ],
  },
  {
    title: "Run an organisation", blurb: "For businesses and institutions with many sites or people.",
    items: [
      { to: "/org", title: "Organisation", hint: "Sites, budgets, approvals, service levels", icon: <CategoryIcon id="building" /> },
      { to: "/programmes", title: "Programmes", hint: "Skills programmes and outcomes", icon: <CompassIcon />, flag: "institutions.enabled" },
      { to: "/insights", title: "Market insights", hint: "Demand, supply and prices", icon: <GlobeIcon />, flag: "institutions.enabled" },
    ],
  },
  {
    title: "You and your account", blurb: "Alerts, your details and your safety.",
    items: [
      { to: "/notifications", title: "Notifications", hint: "Everything that needs you", icon: <ChatIcon /> },
      { to: "/profile", title: "Profile", hint: "Your account and provider profile", icon: <UserIcon /> },
      { to: "/settings", title: "Settings", hint: "Language, notifications, your data", icon: <GlobeIcon /> },
      { to: "/safety", title: "Report a safety incident", hint: "Not a substitute for emergency services", icon: <WarnIcon /> },
    ],
  },
  {
    title: "Platform staff", blurb: "Only visible to staff.",
    items: [
      { to: "/admin", title: "Payout approvals", hint: "Approve or reject payout requests", icon: <WalletIcon />, admin: true },
      { to: "/admin/console", title: "Admin console", hint: "Flags, queues, markets, events", icon: <ShieldIcon />, admin: true },
    ],
  },
];

export default function More() {
  const { user } = useAuth();
  const isAdmin = useIsAdmin(user?.id);
  const flags = useLoad(() => api<{ flags: Record<string, boolean> }>("GET", "/flags").catch(() => ({ flags: {} as Record<string, boolean> })));
  const visible = (i: Item) => (!i.flag || flags.data?.flags[i.flag] !== false) && (!i.admin || isAdmin);
  const groups = GROUPS.map((g) => ({ ...g, items: g.items.filter(visible) })).filter((g) => g.items.length > 0);

  return (
    <div className="space-y-8">
      <h1 className="text-3xl font-bold">Everything else</h1>
      {groups.map((g) => (
        <section key={g.title} className="space-y-3">
          <div>
            <h2 className="text-lg font-semibold">{g.title}</h2>
            <p className="text-sm text-ink/60">{g.blurb}</p>
          </div>
          <ul className="grid gap-3 sm:grid-cols-2">
            {g.items.map((i) => (
              <li key={i.to}>
                <Link to={i.to} className="group flex items-center gap-3 rounded-2xl border border-line bg-surface p-3.5 transition hover:-translate-y-0.5 hover:border-brand/40 hover:shadow-lg hover:shadow-brand/10">
                  <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand/10 text-brand transition group-hover:bg-brand group-hover:text-onbrand">{i.icon}</span>
                  <span><span className="block font-semibold leading-tight">{i.title}</span><span className="text-xs text-ink/60">{i.hint}</span></span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
