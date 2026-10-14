import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, setUnauthorizedHandler, tokenStore } from "./api";
import type { User } from "./types";

type AuthValue = {
  user: User | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (displayName: string, email: string, password: string, marketCode: string) => Promise<void>;
  signOut: () => Promise<void>;
};

const Ctx = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(() => tokenStore.get() !== null);

  const loadMe = useCallback(async () => {
    const r = await api<{ user: User }>("GET", "/me");
    setUser(r.user);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => { tokenStore.clear(); setUser(null); });
    if (tokenStore.get()) {
      loadMe().catch(() => tokenStore.clear()).finally(() => setLoading(false));
    }
    return () => setUnauthorizedHandler(null);
  }, [loadMe]);

  const signIn = useCallback(async (email: string, password: string) => {
    const r = await api<{ token: string }>("POST", "/auth/login", { email, password });
    tokenStore.set(r.token);
    await loadMe();
  }, [loadMe]);

  const signUp = useCallback(async (displayName: string, email: string, password: string, marketCode: string) => {
    const r = await api<{ token: string }>("POST", "/auth/register", {
      email,
      password,
      displayName,
      preferredLanguage: "en",
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      marketCode,
    });
    tokenStore.set(r.token);
    await loadMe();
  }, [loadMe]);

  const signOut = useCallback(async () => {
    try { await api("POST", "/auth/logout", {}); } catch { /* the token may already be invalid */ }
    tokenStore.clear();
    setUser(null);
  }, []);

  const value = useMemo(() => ({ user, loading, signIn, signUp, signOut }), [user, loading, signIn, signUp, signOut]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth must be used inside AuthProvider");
  return v;
}
