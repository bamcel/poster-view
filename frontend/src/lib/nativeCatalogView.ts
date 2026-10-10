import type { NativeCatalogEntry } from "../api/nativeLibraries";

const identifierCache = new WeakMap<NativeCatalogEntry, Record<string, string>>();

function ids(entry: NativeCatalogEntry): Record<string, string> {
  const cached = identifierCache.get(entry);
  if (cached) return cached;
  const raw = entry.metadata.identifiers;
  const result = raw && typeof raw === "object" && !Array.isArray(raw)
    ? Object.fromEntries(
        Object.entries(raw)
          .filter(([, value]) => value != null && String(value).trim())
          .map(([key, value]) => [key.toLowerCase(), String(value).trim()]),
      )
    : {};
  identifierCache.set(entry, result);
  return result;
}
function sameSeries(a: NativeCatalogEntry, b: NativeCatalogEntry) {
  const left = ids(a),
    right = ids(b);
  const strong = ["tvdb", "tmdb", "imdb"];
  const anime = ["anilist", "mal", "anidb"];
  if ([...strong, ...anime].some((key) => left[key] && right[key] && left[key] !== right[key]))
    return false;
  if (strong.some((key) => left[key] && left[key] === right[key])) return true;
  return (
    !anime.some((key) => left[key] && right[key] && left[key] !== right[key]) &&
    anime.some((key) => left[key] && left[key] === right[key])
  );
}

// Presentation grouping only: retain every underlying record and media file.
// Matching titles alone never establishes series identity.
export function nativeCatalogView(input: NativeCatalogEntry[]) {
  const active = input.filter((e) => e.available);
  const aliases = new Map<string, string>();
  const paths = new Map<string, string>();
  const hidden = new Set<string>();
  const groups: NativeCatalogEntry[][] = [];
  for (const entry of active
    .filter((e) => e.kind === "series" && !e.parent_path)
    .sort(
      (a, b) =>
        b.artwork.length - a.artwork.length || a.path.localeCompare(b.path),
    )) {
    const group = groups.find((g) =>
      g.every((member) => sameSeries(member, entry)),
    );
    if (group) group.push(entry);
    else groups.push([entry]);
  }
  for (const group of groups)
    for (const entry of group) {
      aliases.set(entry.id, group[0].id);
      paths.set(entry.path, group[0].path);
      if (entry !== group[0]) hidden.add(entry.id);
    }
  const seasons = new Map<string, NativeCatalogEntry>();
  for (const entry of active
    .filter((e) => e.kind === "season")
    .sort(
      (a, b) =>
        b.artwork.length - a.artwork.length || a.path.localeCompare(b.path),
    )) {
    const parent = entry.parent_path && paths.get(entry.parent_path);
    // Only combine seasons when their parent series were actually grouped.
    if (!parent || !groups.some((g) => g.length > 1 && g[0].path === parent))
      continue;
    const value = entry.metadata.season;
    if (
      value == null ||
      String(value).trim() === "" ||
      !Number.isFinite(Number(value))
    )
      continue;
    const key = `${parent}:${Number(value)}`;
    const canonical = seasons.get(key);
    if (canonical) {
      hidden.add(entry.id);
      aliases.set(entry.id, canonical.id);
      paths.set(entry.path, canonical.path);
    } else seasons.set(key, entry);
  }
  return {
    aliases,
    entries: active
      .filter((e) => !hidden.has(e.id))
      .map((e) => ({
        ...e,
        parent_path: e.parent_path
          ? (paths.get(e.parent_path) ?? e.parent_path)
          : null,
      })),
  };
}
