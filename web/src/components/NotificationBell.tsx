import { useEffect } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { useLoad } from "../lib/useLoad";

/** Unread count, checked every 30 seconds and whenever the inbox changes. */
export function NotificationBell() {
  const inbox = useLoad(() => api<{ unread: number }>("GET", "/notifications"));
  useEffect(() => {
    const id = window.setInterval(() => inbox.reload(), 30_000);
    const onChange = () => inbox.reload();
    window.addEventListener("lp:notifications", onChange);
    return () => { window.clearInterval(id); window.removeEventListener("lp:notifications", onChange); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const n = inbox.data?.unread ?? 0;
  return (
    <Link to="/notifications" aria-label={n > 0 ? `Notifications, ${n} unread` : "Notifications"} className="relative rounded-full p-2 text-ink/70 transition hover:bg-brand/10 hover:text-ink">
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M6 9a6 6 0 1 1 12 0c0 6 2 7 2 7H4s2-1 2-7M10 20a2 2 0 0 0 4 0" /></svg>
      {n > 0 && <span className="absolute -right-0.5 -top-0.5 min-w-[18px] rounded-full bg-gold px-1 text-center text-[11px] font-bold leading-[18px] text-ink">{n > 9 ? "9+" : n}</span>}
    </Link>
  );
}
