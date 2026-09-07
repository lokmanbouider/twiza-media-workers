// Card copy, per locale. Kept tiny and independent — the mobile i18n bundle
// is React-Native-coupled and can't be imported here. Ported verbatim from
// the retired Edge Function (supabase/functions/generate-share-card).

export type CardLocale = "fr" | "ar" | "en";

type CardStrings = {
  before: string;
  after: string;
  participants: (n: number) => string;
  bags: (n: number) => string;
  cleaned: (n: number) => string;
  /** National running total (T5.9), e.g. "1 247 points nettoyés en Algérie". */
  national: (n: number) => string;
  tagline: string;
  rtl: boolean;
};

function groupNum(n: number, locale: string): string {
  try {
    return n.toLocaleString(
      locale === "ar" ? "ar-DZ" : locale === "en" ? "en-GB" : "fr-FR",
    );
  } catch {
    return String(n);
  }
}

const STRINGS: Record<CardLocale, CardStrings> = {
  fr: {
    before: "AVANT",
    after: "APRÈS",
    participants: (n) => `${n} participant${n > 1 ? "s" : ""}`,
    bags: (n) => `${n} sac${n > 1 ? "s" : ""}`,
    cleaned: (n) => `${n} point${n > 1 ? "s" : ""} nettoyé${n > 1 ? "s" : ""}`,
    national: (n) => `${groupNum(n, "fr")} points nettoyés en Algérie`,
    tagline: "Nettoyons l'Algérie, ensemble.",
    rtl: false,
  },
  ar: {
    before: "قبل",
    after: "بعد",
    participants: (n) => `${n} مشارك`,
    bags: (n) => `${n} كيس`,
    cleaned: (n) => `${n} نقطة نُظّفت`,
    national: (n) => `${groupNum(n, "ar")} نقطة نُظّفت في الجزائر`,
    tagline: "لِنُنظّف الجزائر معًا.",
    rtl: true,
  },
  en: {
    before: "BEFORE",
    after: "AFTER",
    participants: (n) => `${n} participant${n > 1 ? "s" : ""}`,
    bags: (n) => `${n} bag${n > 1 ? "s" : ""}`,
    cleaned: (n) => `${n} spot${n > 1 ? "s" : ""} cleaned`,
    national: (n) => `${groupNum(n, "en")} spots cleaned across Algeria`,
    tagline: "Let's clean up Algeria, together.",
    rtl: false,
  },
};

export function cardStrings(locale: string): CardStrings {
  return STRINGS[locale as CardLocale] ?? STRINGS.fr;
}

/** Locale-aware date, e.g. "12 août 2026". */
export function formatCardDate(iso: string | null, locale: string): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString(
      locale === "ar" ? "ar-DZ" : locale === "en" ? "en-GB" : "fr-FR",
      { day: "numeric", month: "long", year: "numeric" },
    );
  } catch {
    return "";
  }
}
