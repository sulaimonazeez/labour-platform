import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

type Item = { id: number; tone: "success" | "error"; text: string };
const Ctx = createContext<{ success: (t: string) => void; error: (t: string) => void } | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Item[]>([]);

  const push = useCallback((tone: Item["tone"], text: string) => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x.slice(-2), { id, tone, text }]);
    window.setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), 4000);
  }, []);

  const value = useMemo(() => ({ success: (t: string) => push("success", t), error: (t: string) => push("error", t) }), [push]);

  return (
    <Ctx.Provider value={value}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-24 z-50 flex flex-col items-center gap-2 px-4 md:bottom-8">
        {items.map((t) => (
          <div
            key={t.id} role="status"
            className={`toast-in pointer-events-auto flex max-w-sm items-center gap-2 rounded-xl px-4 py-3 text-sm font-medium shadow-lg ${t.tone === "success" ? "bg-ink text-paper" : "bg-alarm text-white"}`}
          >
            <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${t.tone === "success" ? "bg-gold" : "bg-white"}`} />
            {t.text}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useToast must be used inside ToastProvider");
  return v;
}
