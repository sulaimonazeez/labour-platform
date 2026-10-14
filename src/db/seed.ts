import "dotenv/config";
import { eq } from "drizzle-orm";
import { db, queryClient } from "./client.js";
import {
  currencies, languages, markets, marketCurrencies, marketLanguages,
  serviceCategories, serviceCategoryTranslations, serviceCategorySynonyms,
} from "./schema/index.js";

async function upsertCategory(opts: {
  key: string;
  parentId?: string;
  meaning: string;
  risk: "low" | "medium" | "high" | "critical";
  names: Record<string, string>;
  synonyms?: Array<{ lang: string; term: string }>;
}) {
  const [row] = await db
    .insert(serviceCategories)
    .values({
      canonicalKey: opts.key,
      parentId: opts.parentId ?? null,
      meaning: opts.meaning,
      riskLevel: opts.risk,
    })
    .onConflictDoUpdate({
      target: serviceCategories.canonicalKey,
      set: { meaning: opts.meaning, riskLevel: opts.risk },
    })
    .returning({ id: serviceCategories.id });

  for (const [languageCode, name] of Object.entries(opts.names)) {
    await db
      .insert(serviceCategoryTranslations)
      .values({ categoryId: row.id, languageCode, name })
      .onConflictDoUpdate({
        target: [serviceCategoryTranslations.categoryId, serviceCategoryTranslations.languageCode],
        set: { name },
      });
  }
  for (const s of opts.synonyms ?? []) {
    await db
      .insert(serviceCategorySynonyms)
      .values({ categoryId: row.id, languageCode: s.lang, term: s.term })
      .onConflictDoNothing();
  }
  return row.id;
}

async function main() {
  await db.insert(languages).values([
    { code: "en", nameNative: "English", nameEnglish: "English" },
    { code: "fr", nameNative: "Français", nameEnglish: "French" },
    { code: "es", nameNative: "Español", nameEnglish: "Spanish" },
    { code: "pt", nameNative: "Português", nameEnglish: "Portuguese" },
    { code: "ar", nameNative: "العربية", nameEnglish: "Arabic", direction: "rtl" },
  ]).onConflictDoNothing();

  await db.insert(currencies).values([
    { code: "NGN", name: "Nigerian Naira", minorUnitExponent: 2 },
    { code: "USD", name: "US Dollar", minorUnitExponent: 2 },
    { code: "EUR", name: "Euro", minorUnitExponent: 2 },
  ]).onConflictDoNothing();

  await db.insert(markets).values({
    code: "NG",
    name: "Nigeria",
    defaultLanguage: "en",
    defaultCurrency: "NGN",
    defaultTimezone: "Africa/Lagos",
    measurementSystem: "metric",
    workingDays: [1, 2, 3, 4, 5],
    addressFormat: { fields: ["line1", "line2", "area", "city", "state", "postal_code"] },
    isActive: true,
  }).onConflictDoNothing();

  const [ng] = await db.select({ id: markets.id }).from(markets).where(eq(markets.code, "NG"));
  await db.insert(marketLanguages).values({ marketId: ng.id, languageCode: "en", isDefault: true }).onConflictDoNothing();
  await db.insert(marketCurrencies).values({ marketId: ng.id, currencyCode: "NGN", isDefault: true }).onConflictDoNothing();

  const home = await upsertCategory({
    key: "home_services",
    meaning: "Services performed at or for a residential property",
    risk: "low",
    names: { en: "Home services", fr: "Services à domicile", es: "Servicios para el hogar", pt: "Serviços domésticos" },
  });
  await upsertCategory({
    key: "plumbing_residential",
    parentId: home,
    meaning: "Repair, installation and maintenance of residential water and drainage systems",
    risk: "medium",
    names: { en: "Plumbing", fr: "Plomberie", es: "Fontanería", pt: "Canalização" },
    synonyms: [
      { lang: "en", term: "leaking tap" },
      { lang: "en", term: "water coming from ceiling" },
    ],
  });
  await upsertCategory({
    key: "electrical_residential_installation",
    parentId: home,
    meaning: "Installation and repair of residential electrical wiring and fixtures",
    risk: "high",
    names: { en: "Electrical installation", fr: "Installation électrique", es: "Instalación eléctrica", pt: "Instalação elétrica" },
    synonyms: [{ lang: "en", term: "room has no power" }],
  });
  await upsertCategory({
    key: "cleaning_residential",
    parentId: home,
    meaning: "Cleaning of residential properties",
    risk: "low",
    names: { en: "Cleaning", fr: "Nettoyage", es: "Limpieza", pt: "Limpeza" },
  });

  console.log("seed complete");
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => queryClient.end());
