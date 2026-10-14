import type { SVGProps } from "react";
import type { IconId } from "../lib/taxonomy";

const base = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, viewBox: "0 0 24 24", "aria-hidden": true };
type P = SVGProps<SVGSVGElement>;
const I = (d: string) => ({ className, ...p }: P) => (
  <svg {...base} className={className ?? "h-5 w-5"} {...p}><path d={d} /></svg>
);

export const SendIcon = I("M22 2 11 13M22 2l-7 20-4-9-9-4z");
export const CheckIcon = ({ className, ...p }: P) => (
  <svg {...base} strokeWidth={2.6} className={className ?? "h-5 w-5"} {...p}><path className="check-draw" d="M5 12.5l4.5 4.5L19 7.5" /></svg>
);
export const MicIcon = ({ className, ...p }: P) => (
  <svg {...base} className={className ?? "h-5 w-5"} {...p}><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>
);
export const SearchIcon = ({ className, ...p }: P) => (
  <svg {...base} className={className ?? "h-5 w-5"} {...p}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
);
export const UserIcon = ({ className, ...p }: P) => (
  <svg {...base} className={className ?? "h-5 w-5"} {...p}><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7" /></svg>
);
export const SparkIcon = I("M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z");
export const ArrowRight = I("M5 12h14M13 6l6 6-6 6");
export const ShieldIcon = I("M12 3l8 3v6c0 4.5-3.2 8-8 9-4.8-1-8-4.5-8-9V6z M9 12l2 2 4-4");
export const ChatIcon = I("M4 5h16v11H9l-5 4z");
export const GlobeIcon = ({ className, ...p }: P) => (
  <svg {...base} className={className ?? "h-5 w-5"} {...p}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18" /></svg>
);
export const CameraIcon = ({ className, ...p }: P) => (
  <svg {...base} className={className ?? "h-5 w-5"} {...p}><path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></svg>
);
export const LayersIcon = I("M12 3 3 8l9 5 9-5zM3 13l9 5 9-5M3 17.5l9 5 9-5");
export const PinIcon = ({ className, ...p }: P) => (
  <svg {...base} className={className ?? "h-5 w-5"} {...p}><path d="M12 21s7-6 7-11a7 7 0 0 0-14 0c0 5 7 11 7 11z" /><circle cx="12" cy="10" r="2.5" /></svg>
);
export const ClockIcon = ({ className, ...p }: P) => (
  <svg {...base} className={className ?? "h-5 w-5"} {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
);
export const WarnIcon = I("M12 3 2 20h20zM12 10v5M12 18v.5");
export const PlusIcon = I("M12 5v14M5 12h14");
export const RefreshIcon = I("M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7");
export const WalletIcon = I("M3 7h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 7l2-3h12M16 14h2");
export const MenuIcon = I("M4 7h16M4 12h16M4 17h16");
export const CompassIcon = ({ className, ...p }: P) => (
  <svg {...base} className={className ?? "h-5 w-5"} {...p}><circle cx="12" cy="12" r="9" /><path d="m15.5 8.5-2 5-5 2 2-5z" /></svg>
);

const CAT: Record<IconId, string> = {
  drop: "M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z",
  bolt: "M13 2 4 14h7l-1 8 9-12h-7z",
  broom: "M14 3l-4 8M8 11h8l2 10H6zM9 16h6",
  door: "M6 3h12v18H6zM14.5 12v.5M3 21h18",
  paint: "M4 4h13v6H4zM17 7h3v5h-8v3M11 15v6",
  sun: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
  truck: "M2 6h12v10H2zM14 9h4l4 4v3h-8zM6 19a2 2 0 1 0 0-.01M18 19a2 2 0 1 0 0-.01",
  snow: "M12 2v20M4.5 6.5l15 11M19.5 6.5l-15 11M9 3.5l3 2 3-2M9 20.5l3-2 3 2",
  plug: "M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4",
  leaf: "M5 19C5 9 11 4 20 4c0 9-5 15-15 15zM5 19c3-5 6-8 10-10",
  bug: "M9 8a3 3 0 0 1 6 0v8a3 3 0 0 1-6 0zM3 12h4M17 12h4M5 6l3 2M19 6l-3 2M5 18l3-2M19 18l-3-2",
  car: "M3 15V11l2-5h14l2 5v4zM3 15h18v3H3zM7 15v.5M17 15v.5",
  hammer: "M14 4l6 6-3 3-6-6zM12 9 4 17l3 3 8-8",
  building: "M5 21V4h9v17M14 9h5v12M8 8h3M8 12h3M8 16h3M3 21h18",
  briefcase: "M3 8h18v12H3zM9 8V5h6v3M3 13h18",
  calendar: "M4 6h16v14H4zM4 10h16M8 3v4M16 3v4",
};

export function CategoryIcon({ id, className = "h-5 w-5" }: { id: IconId; className?: string }) {
  return <svg {...base} className={className}><path d={CAT[id]} /></svg>;
}
