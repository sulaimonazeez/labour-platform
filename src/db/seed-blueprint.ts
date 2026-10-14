import "dotenv/config";
import { and, eq } from "drizzle-orm";
import { db, queryClient } from "./client";
import {
  cancellationPolicies, featureFlags, projectTemplates, retentionPolicies, serviceCategories, serviceCategorySynonyms, serviceCategoryTranslations, templateVersions,
} from "./schema";

// Safe to run any number of times. Run AFTER `npm run db:seed` (it needs the languages and the first categories).
// It adds the canonical service taxonomy with translations and synonyms (PRD §24), a small approved template library
// (PRD §22), the default flags, the standard cancellation policy (PRD §74) and default retention classes (PRD §130).

type Cat = { key: string; risk: "low" | "medium" | "high" | "critical"; meaning: string; names: Record<string, string>; terms: string[]; extra?: Record<string, string[]> };

const CATS: Cat[] = [
  { key: "plumbing_residential", risk: "medium", meaning: "Repair and installation of household water supply, drainage and fixtures", names: { en: "Plumbing", fr: "Plomberie", es: "Fontanería", pt: "Canalização" },
    terms: ["plumb*", "leak*", "tap", "taps", "faucet", "pipe", "pipes", "drain", "drains", "blocked drain", "toilet", "sink", "geyser", "water heater", "burst pipe", "dripping", "water coming", "water from ceiling", "water from the ceiling"],
    extra: { fr: ["fuite", "robinet", "tuyau", "plombier", "toilettes"], es: ["fuga", "grifo", "tubería", "fontanero", "inodoro"], pt: ["vazamento", "torneira", "cano", "canalizador", "canalização"] } },
  { key: "electrical_residential_installation", risk: "high", meaning: "Household wiring, sockets, lighting and electrical fault finding", names: { en: "Electrical", fr: "Électricité", es: "Electricidad", pt: "Eletricidade" },
    terms: ["electric*", "wiring", "socket", "sockets", "outlet", "switch", "switches", "no power", "no light", "no lights", "power", "breaker", "fuse", "tripping", "short circuit", "bulb", "light fitting"],
    extra: { fr: ["électricien", "prise", "disjoncteur", "panne de courant"], es: ["electricista", "enchufe", "interruptor", "sin luz"], pt: ["eletricista", "tomada", "disjuntor", "sem energia"] } },
  { key: "cleaning_residential", risk: "low", meaning: "Cleaning of homes and small offices", names: { en: "Cleaning", fr: "Nettoyage", es: "Limpieza", pt: "Limpeza" },
    terms: ["clean*", "mop", "mopping", "sweep", "tidy", "deep clean", "housekeeping", "laundry"],
    extra: { fr: ["ménage", "nettoyer"], es: ["limpiar", "limpieza"], pt: ["limpar", "faxina"] } },
  { key: "carpentry_doors_locks", risk: "low", meaning: "Door repair, locks, cabinets, shelving and furniture work", names: { en: "Doors, locks & carpentry", fr: "Portes, serrures et menuiserie", es: "Puertas, cerraduras y carpintería", pt: "Portas, fechaduras e carpintaria" },
    terms: ["carpent*", "door", "doors", "lock", "locks", "locksmith", "key", "keys", "hinge", "gate", "cabinet", "cabinets", "wardrobe", "shelf", "shelves", "furniture", "wont lock", "door wont lock", "wood"],
    extra: { fr: ["porte", "serrure", "menuisier"], es: ["puerta", "cerradura", "carpintero"], pt: ["porta", "fechadura", "carpinteiro"] } },
  { key: "painting_residential", risk: "low", meaning: "Interior and exterior painting and finishes", names: { en: "Painting", fr: "Peinture", es: "Pintura", pt: "Pintura" },
    terms: ["paint*", "repaint*", "wall", "walls", "wallpaper", "pop ceiling", "emulsion"], extra: { fr: ["peintre", "repeindre"], es: ["pintor", "pintar"], pt: ["pintor", "pintar"] } },
  { key: "solar_installation", risk: "high", meaning: "Solar panels, inverters, batteries and backup power systems", names: { en: "Solar & backup power", fr: "Solaire et énergie de secours", es: "Solar y energía de respaldo", pt: "Solar e energia de reserva" },
    terms: ["solar", "inverter", "inverters", "panels", "solar panel", "solar panels", "battery", "batteries", "backup power", "backup electricity", "backup", "off grid", "keep the lights"],
    extra: { fr: ["panneaux solaires", "onduleur"], es: ["energía solar", "paneles solares", "inversor"], pt: ["energia solar", "painéis solares", "inversor"] } },
  { key: "moving_relocation", risk: "medium", meaning: "Moving, packing, loading and relocating a home or office", names: { en: "Moving & relocation", fr: "Déménagement", es: "Mudanzas", pt: "Mudanças" },
    terms: ["mov*", "relocat*", "movers", "packing", "pack", "removals", "moving house", "move house", "moving out", "move out"],
    extra: { fr: ["déménager", "déménagement"], es: ["mudanza", "mudarme"], pt: ["mudança", "mudar de casa"] } },
  { key: "hvac_cooling", risk: "medium", meaning: "Air conditioning and cooling installation, servicing and repair", names: { en: "Air conditioning", fr: "Climatisation", es: "Aire acondicionado", pt: "Ar condicionado" },
    terms: ["ac", "a c", "aircon", "air conditioner", "air conditioning", "not cooling", "hvac", "split unit"], extra: { fr: ["climatiseur", "clim"], es: ["aire acondicionado"], pt: ["ar condicionado"] } },
  { key: "appliance_repair", risk: "medium", meaning: "Repair of household appliances", names: { en: "Appliance repair", fr: "Réparation d'appareils", es: "Reparación de electrodomésticos", pt: "Reparação de eletrodomésticos" },
    terms: ["appliance*", "fridge", "freezer", "washing machine", "washer", "cooker", "oven", "microwave", "tv", "television", "dishwasher"], extra: { fr: ["frigo", "lave-linge"], es: ["nevera", "lavadora"], pt: ["geladeira", "máquina de lavar"] } },
  { key: "gardening_landscaping", risk: "low", meaning: "Lawn, hedge, tree and garden work", names: { en: "Gardening", fr: "Jardinage", es: "Jardinería", pt: "Jardinagem" },
    terms: ["garden*", "lawn", "grass", "hedge", "landscap*", "tree", "trees", "weeding"], extra: { fr: ["jardin", "pelouse"], es: ["jardín", "césped"], pt: ["jardim", "relva"] } },
  { key: "pest_control", risk: "medium", meaning: "Pest and rodent control and fumigation", names: { en: "Pest control", fr: "Lutte antiparasitaire", es: "Control de plagas", pt: "Controlo de pragas" },
    terms: ["pest*", "cockroach*", "rat", "rats", "rodent*", "termite*", "mosquito*", "bedbug*", "fumigat*", "ants"], extra: { fr: ["cafards", "rats"], es: ["cucarachas", "plagas"], pt: ["baratas", "pragas"] } },
  { key: "vehicle_generator_repair", risk: "medium", meaning: "Vehicle and generator repair and servicing", names: { en: "Mechanic & generators", fr: "Mécanicien et groupes électrogènes", es: "Mecánico y generadores", pt: "Mecânico e geradores" },
    terms: ["mechanic*", "car", "engine", "vehicle", "generator", "generators", "wont start", "car wont start", "tyre", "tire", "brake", "brakes", "service my car"], extra: { fr: ["voiture", "groupe électrogène"], es: ["coche", "generador"], pt: ["carro", "gerador"] } },
  { key: "construction_renovation", risk: "high", meaning: "Building, renovation, tiling, roofing and extensions", names: { en: "Building & renovation", fr: "Construction et rénovation", es: "Construcción y reformas", pt: "Construção e remodelação" },
    terms: ["renovat*", "construct*", "build*", "tiling", "tile", "tiles", "roof", "roofing", "extension", "mason", "bricklayer", "plaster*", "welding", "welder"], extra: { fr: ["rénover", "carrelage", "toiture"], es: ["reformar", "azulejos", "tejado"], pt: ["renovar", "azulejos", "telhado"] } },
  { key: "facility_maintenance", risk: "medium", meaning: "Recurring maintenance across buildings, branches and sites", names: { en: "Facility maintenance", fr: "Maintenance des installations", es: "Mantenimiento de instalaciones", pt: "Manutenção de instalações" },
    terms: ["facility", "facilities", "maintenance", "locations", "sites", "offices", "recurring"], extra: { fr: ["maintenance", "sites"], es: ["mantenimiento", "sedes"], pt: ["manutenção", "instalações"] } },
  { key: "events_catering", risk: "low", meaning: "Events, conferences, weddings and catering", names: { en: "Events & catering", fr: "Événements et traiteur", es: "Eventos y catering", pt: "Eventos e catering" },
    terms: ["conference", "wedding", "party", "event", "events", "caterer", "catering", "cater*", "dj", "photograph*", "venue"], extra: { fr: ["mariage", "traiteur"], es: ["boda", "evento"], pt: ["casamento", "evento"] } },
  { key: "professional_services", risk: "medium", meaning: "Engineers, architects, accountants, lawyers and consultants", names: { en: "Professionals", fr: "Professionnels", es: "Profesionales", pt: "Profissionais" },
    terms: ["professional*", "engineer", "engineering", "architect*", "accountant", "accounting", "lawyer", "solicitor", "consultant", "consulting", "surveyor", "designer", "inspector", "trainer"], extra: { fr: ["architecte", "avocat", "comptable"], es: ["arquitecto", "abogado", "contable"], pt: ["arquiteto", "advogado", "contabilista"] } },
];

const task = (key: string, title: string, o: Partial<{ description: string; deps: string[]; inspect: boolean; criteria: string; materials: string; skills: string[] }> = {}) => ({
  key, title, description: o.description, skills: o.skills ?? [], materialResponsibility: o.materials ?? "not_applicable", dependsOn: o.deps ?? [], inspectionRequired: o.inspect ?? false, acceptanceCriteria: o.criteria,
});

const TEMPLATES: { key: string; title: string; description: string; categoryKey: string; body: Record<string, unknown> }[] = [
  { key: "residential_cleaning_standard", title: "Standard home cleaning", description: "One visit, one cleaner, fixed scope", categoryKey: "cleaning_residential",
    body: { title: "Home cleaning", stages: [{ name: "Clean", tasks: [task("clean", "Clean the agreed rooms", { criteria: "Rooms agreed in the quote are clean; before and after photos taken." }), task("walk", "Walk-through with the customer", { deps: ["clean"], criteria: "Customer confirms or lists anything missed." })] }],
      assumptions: ["Cleaning products are supplied by the cleaner unless the quote says otherwise."], risks: [], materials: [], questionsForProfessional: [],
      questions: [{ id: "rooms", text: "Which rooms need cleaning?" }, { id: "size", text: "Roughly how big is the place (rooms or square metres)?" }, { id: "supplies", text: "Do you have cleaning supplies, or should the cleaner bring them?" }] } },
  { key: "solar_home_install", title: "Home solar and backup power", description: "Assess, design, install and commission a residential solar system", categoryKey: "solar_installation",
    body: { title: "Home solar installation", stages: [
      { name: "Assess and design", tasks: [task("assess", "Site assessment and load survey", { inspect: true, skills: ["solar_design"], criteria: "Written assessment of roof, shading and the loads to be backed up." }), task("design", "System design and quotation", { deps: ["assess"], skills: ["solar_design", "electrical_engineering"], criteria: "Single-line diagram, equipment list and quotation." })] },
      { name: "Supply and install", tasks: [task("equip", "Supply panels, inverter and battery", { deps: ["design"], materials: "merchant", criteria: "Delivery note matches the equipment list." }), task("install", "Install and wire the system", { deps: ["equip"], skills: ["electrician", "solar_installer"], criteria: "Installed to the design with protection devices fitted and labelled." })] },
      { name: "Commission and hand over", tasks: [task("commission", "Test, commission and inspect", { deps: ["install"], inspect: true, criteria: "Commissioning report and inspection sign-off." }), task("handover", "Handover, manuals and warranty", { deps: ["commission"], criteria: "Customer has manuals, warranty documents and the serial numbers." })] }],
      assumptions: ["Final design must be confirmed by a qualified solar or electrical engineer."], risks: ["Electrical work on a building carries shock and fire risk. Use a qualified, insured installer."], materials: ["Solar panels", "Inverter", "Battery", "Mounting", "Protection devices", "Cabling"],
      questionsForProfessional: ["Is the roof structure suitable?", "Is a utility or local permit needed for this connection?"],
      questions: [{ id: "loads", text: "What must keep running when the grid is off (lights, fridge, fans, internet)?" }, { id: "hours", text: "How many hours of backup do you want overnight?" }, { id: "roof", text: "What kind of roof do you have, and is it shaded?" }, { id: "budget", text: "Do you have a budget range?" }] } },
  { key: "home_move_standard", title: "Moving home", description: "Pack, load, transport and settle in", categoryKey: "moving_relocation",
    body: { title: "Moving home", stages: [
      { name: "Plan", tasks: [task("survey", "Survey belongings and agree the plan", { inspect: true, criteria: "Inventory, access notes and moving date agreed." })] },
      { name: "Pack and move", tasks: [task("pack", "Pack and protect belongings", { deps: ["survey"], criteria: "Boxes labelled; fragile items protected." }), task("move", "Load, transport and unload", { deps: ["pack"], criteria: "Everything delivered to the new address; damage noted on arrival." })] },
      { name: "Settle in", tasks: [task("reinstall", "Reassemble furniture and reconnect appliances", { deps: ["move"], skills: ["handyman"] }), task("clean", "Clean the old home", { deps: ["move"] })] }],
      assumptions: [], risks: ["Fragile or high-value items should be listed and, where needed, insured."], materials: ["Boxes", "Packing material"], questionsForProfessional: [],
      questions: [{ id: "from", text: "Moving from where, and what floor or access?" }, { id: "to", text: "Moving to where, and what floor or access?" }, { id: "size", text: "How many rooms of furniture?" }, { id: "date", text: "What is your moving date?" }] } },
  { key: "interior_painting_standard", title: "Interior painting", description: "Prepare and paint interior rooms", categoryKey: "painting_residential",
    body: { title: "Interior painting", stages: [{ name: "Prepare and paint", tasks: [task("prep", "Protect floors and prepare walls", { criteria: "Surfaces cleaned, filled and masked." }), task("paint", "Apply paint", { deps: ["prep"], materials: "shared", criteria: "Even coverage, clean edges, no drips." }), task("finish", "Clean up and walk-through", { deps: ["paint"], criteria: "Customer confirms the finish." })] }],
      assumptions: ["Paint is bought by the customer unless the quote includes it."], risks: [], materials: ["Paint", "Primer", "Masking tape", "Dust sheets"], questionsForProfessional: [],
      questions: [{ id: "rooms", text: "Which rooms, and are the ceilings included?" }, { id: "paint", text: "Do you have the paint, or should the painter supply it?" }, { id: "condition", text: "Any cracks, damp or peeling paint to fix first?" }] } },
];

async function main() {
  for (const c of CATS) {
    const [row] = await db.insert(serviceCategories).values({ canonicalKey: c.key, meaning: c.meaning, riskLevel: c.risk })
      .onConflictDoUpdate({ target: serviceCategories.canonicalKey, set: { meaning: c.meaning } }).returning({ id: serviceCategories.id });
    for (const [languageCode, name] of Object.entries(c.names)) {
      await db.insert(serviceCategoryTranslations).values({ categoryId: row.id, languageCode, name }).onConflictDoUpdate({ target: [serviceCategoryTranslations.categoryId, serviceCategoryTranslations.languageCode], set: { name } });
    }
    for (const term of c.terms) await db.insert(serviceCategorySynonyms).values({ categoryId: row.id, languageCode: "en", term }).onConflictDoNothing();
    for (const [lang, list] of Object.entries(c.extra ?? {})) for (const term of list) await db.insert(serviceCategorySynonyms).values({ categoryId: row.id, languageCode: lang, term }).onConflictDoNothing();
  }

  for (const t of TEMPLATES) {
    const [tpl] = await db.insert(projectTemplates).values({ key: t.key, title: t.title, description: t.description, categoryKey: t.categoryKey, ownerKind: "platform", visibility: "global" })
      .onConflictDoUpdate({ target: projectTemplates.key, set: { title: t.title, description: t.description, categoryKey: t.categoryKey } }).returning({ id: projectTemplates.id });
    const [existing] = await db.select({ id: templateVersions.id }).from(templateVersions).where(and(eq(templateVersions.templateId, tpl.id), eq(templateVersions.version, 1))).limit(1);
    if (!existing) await db.insert(templateVersions).values({ templateId: tpl.id, version: 1, language: "en", body: t.body, sourceKind: "platform", approvalState: "approved", approvedAt: new Date(), regulations: [] });
  }

  for (const [key, description] of [["ai.enabled", "Master switch for every optional AI feature"], ["translation.enabled", "Chat and project translation"], ["commerce.enabled", "Merchants, products and orders"], ["institutions.enabled", "Programmes, registries and insights"]] as const) {
    await db.insert(featureFlags).values({ key, description, enabled: true }).onConflictDoNothing();
  }
  await db.insert(cancellationPolicies).values({ key: "standard", description: "Free until 24 hours before, then 25%, then 50% inside 2 hours", rules: [{ hoursBefore: 24, feePercent: 0 }, { hoursBefore: 2, feePercent: 25 }, { hoursBefore: 0, feePercent: 50 }] }).onConflictDoNothing();
  for (const [dataClass, retainDays] of [["chats", 1095], ["financial", 2555], ["identity", 1825], ["evidence", 1095], ["disputes", 2555], ["deleted_accounts", 30]] as const) {
    const [e] = await db.select({ id: retentionPolicies.id }).from(retentionPolicies).where(eq(retentionPolicies.dataClass, dataClass)).limit(1);
    if (!e) await db.insert(retentionPolicies).values({ dataClass, retainDays, note: "Default. Review per market with your counsel." });
  }
  console.log(`blueprint seed complete: ${CATS.length} categories, ${TEMPLATES.length} templates`);
}

main().then(() => queryClient.end()).catch((e) => { console.error(e); void queryClient.end(); process.exit(1); });
