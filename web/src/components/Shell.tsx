import type { MouseEvent, ReactNode } from "react";
import { Link, NavLink } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { useIsAdmin } from "../lib/useIsAdmin";
import { useTheme } from "../lib/theme";
import { CompassIcon, UserIcon, MenuIcon } from "./Icons";
import { NotificationBell } from "./NotificationBell";
import { FolderIcon, HomeIcon, Logo, MoonIcon, SunIcon } from "./ui";

const navClass = ({ isActive }: { isActive: boolean }) =>
  `rounded-lg px-3 py-1.5 text-sm font-semibold transition ${isActive ? "bg-brand/10 text-brand" : "text-ink/60 hover:text-ink"}`;

const tabClass = ({ isActive }: { isActive: boolean }) =>
  `flex flex-1 flex-col items-center gap-0.5 py-2 text-xs font-semibold transition active:scale-95 ${isActive ? "text-brand" : "text-ink/50"}`;

const closeMenu = (e: MouseEvent<HTMLElement>) => e.currentTarget.closest("details")?.removeAttribute("open");

export function Shell({ children }: { children: ReactNode }) {
  const { user, signOut } = useAuth();
  const isAdmin = useIsAdmin(user?.id);
  const { theme, toggle } = useTheme();
  const initials = (user?.displayName ?? "?").split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase();

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-line bg-paper/85 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-5 py-3">
          <Link to="/" className="flex items-center gap-2.5 font-bold"><Logo /> Labour Platform</Link>
          <nav className="hidden items-center gap-1 md:flex">
            <NavLink to="/" end className={navClass}>Home</NavLink>
            <NavLink to="/find" className={navClass}>Find</NavLink>
            <NavLink to="/projects" className={navClass}>Projects</NavLink>
            <NavLink to="/plan" className={navClass}>Plan</NavLink>
            <NavLink to="/more" className={navClass}>More</NavLink>
          </nav>
          <div className="flex items-center gap-2">
            <NotificationBell />
            <button
              type="button" onClick={toggle} aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
              className="rounded-full p-2 text-ink/70 transition hover:bg-brand/10 hover:text-ink"
            >
              {theme === "dark" ? <SunIcon /> : <MoonIcon />}
            </button>
            <details className="relative">
              <summary aria-label="Account menu" className="flex h-9 w-9 cursor-pointer list-none items-center justify-center rounded-full bg-brand text-sm font-bold text-onbrand transition active:scale-95">{initials}</summary>
              <div className="rise absolute right-0 mt-2 w-60 rounded-2xl border border-line bg-surface p-4 shadow-xl">
                <p className="font-semibold">{user?.displayName}</p>
                {user?.email && <p className="truncate text-sm text-ink/60">{user.email}</p>}
                <Link to="/profile" onClick={closeMenu} className="mt-3 block w-full rounded-xl border border-line px-3 py-2 text-center text-sm font-semibold hover:bg-brand/5">View profile</Link>
                <Link to="/settings" onClick={closeMenu} className="mt-2 block w-full rounded-xl border border-line px-3 py-2 text-center text-sm font-semibold hover:bg-brand/5">Settings</Link>
                {isAdmin && <Link to="/admin" onClick={closeMenu} className="mt-2 block w-full rounded-xl border border-gold/60 bg-gold/10 px-3 py-2 text-center text-sm font-semibold">Admin</Link>}
                <button type="button" onClick={() => void signOut()} className="mt-2 w-full rounded-xl border border-line px-3 py-2 text-sm font-semibold hover:bg-brand/5">Sign out</button>
              </div>
            </details>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-5 pb-28 pt-6 md:pb-16">{children}</main>

      <nav className="fixed inset-x-0 bottom-0 z-30 flex border-t border-line bg-paper/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
        <NavLink to="/" end className={tabClass}><HomeIcon /> Home</NavLink>
        <NavLink to="/find" className={tabClass}><CompassIcon /> Find</NavLink>
        <NavLink to="/projects" className={tabClass}><FolderIcon /> Projects</NavLink>
        <NavLink to="/more" className={tabClass}><MenuIcon /> More</NavLink>
      </nav>
    </div>
  );
}
