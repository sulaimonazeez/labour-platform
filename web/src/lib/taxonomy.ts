// Deterministic "what do you need done?" understanding (PRD §3, §37, §80, §106).
// It runs on the device with plain rules: no AI, no network, never blocks a request.
// PRD §24 says the taxonomy must come from the database. Until the API has a categories endpoint this is a
// client-side mirror. `seeded: true` marks the keys that exist in `db:seed`; only those are ever sent to the API.

export type Risk = "low" | "medium" | "high";
export type RequestPath = "quick_service" | "ai_assisted" | "managed_project";
export type IconId =
  | "drop" | "bolt" | "broom" | "door" | "paint" | "sun" | "truck" | "snow" | "plug"
  | "leaf" | "bug" | "car" | "hammer" | "building" | "briefcase" | "calendar";

export type Category = {
  key: string;
  name: string;
  blurb: string;
  risk: Risk;
  icon: IconId;
  path: RequestPath;
  seeded: boolean;
  /** Word used to look providers up by name/headline (GET /providers?q=). */
  search: string;
  /** Normalised words/phrases. A trailing * means "starts with". */
  terms: string[];
  example: string;
};

export const CATEGORIES: Category[] = [
  { key: "plumbing_residential", name: "Plumbing", blurb: "Leaks, taps, drains, toilets, water heaters", risk: "medium", icon: "drop", path: "quick_service", seeded: true, search: "plumb",
    example: "Water is leaking through my ceiling",
    terms: ["plumb*", "leak*", "tap", "taps", "faucet", "pipe", "pipes", "drain", "drains", "blocked drain", "toilet", "sink", "geyser", "water heater", "burst pipe", "dripping", "water coming", "water from ceiling", "water from the ceiling"] },
  { key: "electrical_residential_installation", name: "Electrical", blurb: "Wiring, sockets, lights, breakers, power faults", risk: "high", icon: "bolt", path: "quick_service", seeded: true, search: "electric",
    example: "The room has no power",
    terms: ["electric*", "wiring", "socket", "sockets", "outlet", "switch", "switches", "no power", "no light", "no lights", "power", "breaker", "fuse", "tripping", "short circuit", "bulb", "light fitting"] },
  { key: "cleaning_residential", name: "Cleaning", blurb: "Homes, offices, deep cleans, move-out cleans", risk: "low", icon: "broom", path: "quick_service", seeded: true, search: "clean",
    example: "Clean my apartment tomorrow",
    terms: ["clean*", "mop", "mopping", "sweep", "tidy", "deep clean", "housekeeping", "laundry"] },
  { key: "carpentry_doors_locks", name: "Doors, locks & carpentry", blurb: "Door repairs, locks, cabinets, shelves, furniture", risk: "low", icon: "door", path: "quick_service", seeded: false, search: "carpent",
    example: "My door won't lock",
    terms: ["carpent*", "door", "doors", "lock", "locks", "locksmith", "key", "keys", "hinge", "gate", "cabinet", "cabinets", "wardrobe", "shelf", "shelves", "furniture", "wont lock", "door wont lock", "wood"] },
  { key: "painting_residential", name: "Painting", blurb: "Interior and exterior painting, repainting, finishes", risk: "low", icon: "paint", path: "quick_service", seeded: false, search: "paint",
    example: "We need two rooms repainted",
    terms: ["paint*", "repaint*", "wall", "walls", "wallpaper", "pop ceiling", "emulsion"] },
  { key: "solar_installation", name: "Solar & backup power", blurb: "Solar, inverters, batteries, backup electricity", risk: "high", icon: "sun", path: "ai_assisted", seeded: false, search: "solar",
    example: "I want solar installed",
    terms: ["solar", "inverter", "inverters", "panels", "solar panel", "solar panels", "battery", "batteries", "backup power", "backup electricity", "backup", "off grid", "keep the lights"] },
  { key: "moving_relocation", name: "Moving & relocation", blurb: "Movers, packing, loading, relocating a home or office", risk: "medium", icon: "truck", path: "managed_project", seeded: false, search: "mov",
    example: "I am moving to another house",
    terms: ["mov*", "relocat*", "movers", "packing", "pack", "removals", "moving house", "move house", "moving out", "move out"] },
  { key: "hvac_cooling", name: "Air conditioning", blurb: "AC installation, servicing, gas refills, repairs", risk: "medium", icon: "snow", path: "quick_service", seeded: false, search: "air",
    example: "My AC is not cooling",
    terms: ["ac", "a c", "aircon", "air conditioner", "air conditioning", "not cooling", "hvac", "split unit"] },
  { key: "appliance_repair", name: "Appliance repair", blurb: "Fridges, washing machines, cookers, TVs", risk: "medium", icon: "plug", path: "quick_service", seeded: false, search: "appliance",
    example: "My fridge stopped cooling",
    terms: ["appliance*", "fridge", "freezer", "washing machine", "washer", "cooker", "oven", "microwave", "tv", "television", "dishwasher"] },
  { key: "gardening_landscaping", name: "Gardening", blurb: "Lawns, hedges, trees, landscaping", risk: "low", icon: "leaf", path: "quick_service", seeded: false, search: "garden",
    example: "Trim the hedge and cut the grass",
    terms: ["garden*", "lawn", "grass", "hedge", "landscap*", "tree", "trees", "weeding"] },
  { key: "pest_control", name: "Pest control", blurb: "Cockroaches, rodents, termites, fumigation", risk: "medium", icon: "bug", path: "quick_service", seeded: false, search: "pest",
    example: "We have cockroaches in the kitchen",
    terms: ["pest*", "cockroach*", "rat", "rats", "rodent*", "termite*", "mosquito*", "bedbug*", "fumigat*", "ants"] },
  { key: "vehicle_generator_repair", name: "Mechanic & generators", blurb: "Car repairs, servicing, generator maintenance", risk: "medium", icon: "car", path: "quick_service", seeded: false, search: "mechanic",
    example: "My generator won't start",
    terms: ["mechanic*", "car", "engine", "vehicle", "generator", "generators", "wont start", "car wont start", "tyre", "tire", "brake", "brakes", "service my car"] },
  { key: "construction_renovation", name: "Building & renovation", blurb: "Renovations, tiling, roofing, extensions, construction", risk: "high", icon: "hammer", path: "managed_project", seeded: false, search: "build",
    example: "I want to renovate my kitchen",
    terms: ["renovat*", "construct*", "build*", "tiling", "tile", "tiles", "roof", "roofing", "extension", "mason", "bricklayer", "plaster*", "welding", "welder"] },
  { key: "facility_maintenance", name: "Facility maintenance", blurb: "Recurring maintenance across branches and sites", risk: "medium", icon: "building", path: "managed_project", seeded: false, search: "facilit",
    example: "We need maintenance performed across 200 facilities",
    terms: ["facility", "facilities", "maintenance", "locations", "sites", "offices", "recurring"] },
  { key: "events_catering", name: "Events & catering", blurb: "Conferences, weddings, parties, caterers", risk: "low", icon: "calendar", path: "managed_project", seeded: false, search: "cater",
    example: "We need to organise a conference",
    terms: ["conference", "wedding", "party", "event", "events", "caterer", "catering", "cater*", "dj", "photograph*", "venue"] },
  { key: "professional_services", name: "Professionals", blurb: "Engineers, architects, accountants, lawyers, consultants", risk: "medium", icon: "briefcase", path: "ai_assisted", seeded: false, search: "consult",
    example: "I need an architect for my plot",
    terms: ["professional*", "engineer", "engineering", "architect*", "accountant", "accounting", "lawyer", "solicitor", "consultant", "consulting", "surveyor", "designer", "inspector", "trainer"] },
];

export const EXAMPLES = [
  "My door won't lock",
  "Water is leaking through my ceiling",
  "I want solar installed",
  "We need two rooms repainted",
  "I am moving to another house",
  "The room has no power",
];

const MANAGED = [
  /\brelocat/, /\bmoving (my |our |the )?(office|business|shop|store)\b/, /\b\d{2,}\s+(locations|facilities|branches|offices|sites|shops|stores)\b/,
  /\b(branches|facilities)\b/, /\bconference\b/, /\bopen(ing)? (a |an |another )?(new )?(restaurant|office|branch|shop|store|clinic)\b/,
  /\brenovat/, /\bconstruct/, /\bbuild(ing)? (a|an|my|our)\b/, /\bwhole (house|building)\b/, /\bmoving (to|house|out)\b/, /\bmove (house|out)\b/,
];
const GUIDED = [
  /\bsolar\b/, /\binverter/, /\bbackup (power|electricity)\b/, /\bnot sure\b/, /\bdont know\b/, /\bhelp me (figure|plan|decide|understand)\b/, /\bcctv\b/, /\bsmart home\b/,
];
const EMERGENCY: { re: RegExp; kind: string }[] = [
  { re: /\bgas (leak|smell)|smell(s|ing)? (of )?gas\b/, kind: "gas leak" },
  { re: /\bon fire\b|\bfire\b|\bsmoke\b|\bburning smell\b/, kind: "fire or smoke" },
  { re: /\belectrocut|\belectric shock\b|\bsparking\b|\bexposed live wire/, kind: "electrical hazard" },
  { re: /\binjured\b|\bunconscious\b|\bnot breathing\b|\bbleeding\b|\bchest pain\b|\bheart attack\b/, kind: "medical emergency" },
  { re: /\bintruder\b|\bbreak ?in\b|\bbeing attacked\b|\bsomeone is (inside|attacking)\b/, kind: "personal safety" },
];

export type Match = { category: Category; score: number };
export type Emergency = { kind: string };
export type Understanding = {
  text: string;
  matches: Match[];
  top: Category | null;
  /** True when one category clearly wins. Only then is a category key sent to the API. */
  confident: boolean;
  path: RequestPath;
  emergency: Emergency | null;
};

function normalise(s: string): string {
  return s.toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function hits(words: string[], padded: string, term: string): boolean {
  if (term.endsWith("*")) {
    const stem = term.slice(0, -1);
    return words.some((w) => w.startsWith(stem));
  }
  return padded.includes(` ${term} `);
}

export function understand(input: string): Understanding {
  const text = input.trim();
  const norm = normalise(text);
  const words = norm.length === 0 ? [] : norm.split(" ");
  const padded = ` ${norm} `;

  const matches: Match[] = [];
  for (const category of CATEGORIES) {
    let score = 0;
    for (const t of category.terms) {
      if (hits(words, padded, t)) score += t.includes(" ") ? 3 : 2;
    }
    if (score > 0) matches.push({ category, score });
  }
  matches.sort((a, b) => b.score - a.score);
  const top = matches[0]?.category ?? null;
  const confident = matches.length > 0 && (matches.length === 1 || matches[0].score >= matches[1].score + 2);

  let path: RequestPath = "quick_service";
  if (MANAGED.some((r) => r.test(norm))) path = "managed_project";
  else if (GUIDED.some((r) => r.test(norm))) path = "ai_assisted";
  else if (top && top.path !== "quick_service" && confident) path = top.path;

  const emergency = EMERGENCY.find((e) => e.re.test(norm)) ?? null;
  return { text, matches: matches.slice(0, 3), top, confident, path, emergency: emergency ? { kind: emergency.kind } : null };
}

export const PATH_INFO: Record<RequestPath, { label: string; why: string }> = {
  quick_service: { label: "Quick service", why: "You know what you need. Get quotes, pick someone, and pay when the work is approved." },
  ai_assisted: { label: "Let's scope it together", why: "This one needs a clear spec before anyone can quote. Add detail and we will shape the scope." },
  managed_project: { label: "Managed project", why: "Several tasks and people are involved, so it works best as a project with stages and approvals." },
};

export const RISK_NOTE: Record<Risk, string | null> = {
  low: null,
  medium: null,
  high: "Higher-risk work. Ask providers for proof of qualification before you accept a quote.",
};

export const EMERGENCY_NOTE =
  "This could be an emergency. Contact your local emergency services first. Labour Platform is a marketplace, not an emergency service.";
