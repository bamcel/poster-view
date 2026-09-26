import type { Credit, CreditSource } from "../api/credits";

export const creditProviders: Record<string, string> = { anilist: "AniList", mal: "MyAnimeList via Jikan", tvdb: "TheTVDB", tmdb: "TMDb" };
export type CastMode = "both" | "original" | "dub" | "all";
export interface CastPreference { mode: CastMode; language: string; }
export function readCastPreference(key: string): CastPreference {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null");
    if (value && ["both", "original", "dub", "all"].includes(value.mode) && typeof value.language === "string" && value.language.length <= 64) return value;
  } catch { /* Optional browser storage. */ }
  return { mode: "both", language: "en" };
}
export function languageName(code: string): string {
  try { return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code; } catch { return code[0]?.toUpperCase() + code.slice(1); }
}
export interface DisplayCredit extends Credit { sources: { provider: string; url: string | null }[]; }
const nameKey = (value: string) => value.includes(",") ? value.split(",").reverse().join(" ").trim().toLocaleLowerCase().replace(/\s+/g, " ") : value.trim().toLocaleLowerCase().replace(/\s+/g, " ");

// Coalesce identical displayed credit labels only. Provider identities stay separate in storage.
export function displayCredits(sources: CreditSource[]): DisplayCredit[] {
  const rows = new Map<string, DisplayCredit>();
  for (const source of sources) for (const credit of source.credits) {
    const key = JSON.stringify([nameKey(credit.name), nameKey(credit.character ?? ""), credit.category, credit.category === "crew" ? credit.role.toLowerCase() : "", credit.language, credit.dub_group, credit.notes]);
    const existing = rows.get(key);
    if (existing) {
      if (!existing.sources.some(s => s.provider === source.provider)) existing.sources.push({ provider: source.provider, url: credit.person_url });
      existing.image ??= credit.image;
      existing.character_image ??= credit.character_image;
    } else rows.set(key, { ...credit, sources: [{ provider: source.provider, url: credit.person_url }] });
  }
  return [...rows.values()];
}

export function castGroups(credits: DisplayCredit[], original: string | null, preference: CastPreference): { label: string; credits: DisplayCredit[] }[] {
  const cast = credits.filter(c => c.category === "cast");
  const groups: { label: string; credits: DisplayCredit[] }[] = [];
  if (preference.mode === "original" || preference.mode === "both") {
    groups.push({ label: original ? `Original cast · ${languageName(original)}` : "Original cast", credits: original ? cast.filter(c => c.language === original) : [] });
  }
  if ((preference.mode === "both" && preference.language !== original) || preference.mode === "dub") {
    groups.push({ label: `${languageName(preference.language)} cast`, credits: cast.filter(c => c.language === preference.language) });
  }
  if (preference.mode === "all") for (const language of [...new Set(cast.map(c => c.language).filter((v): v is string => !!v))].sort()) {
    groups.push({ label: `${languageName(language)} cast${language === original ? " · Original" : ""}`, credits: cast.filter(c => c.language === language) });
  }
  if (preference.mode !== "dub" && cast.some(c => !c.language)) groups.push({ label: "Cast · language unspecified", credits: cast.filter(c => !c.language) });
  return groups;
}
