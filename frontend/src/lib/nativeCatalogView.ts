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
const strong = ["tvdb", "tmdb", "imdb"] as const;
const anime = ["anilist", "mal", "anidb"] as const;
const identityProviders = [...strong, ...anime];

function sameSeries(a: NativeCatalogEntry, b: NativeCatalogEntry) {
  const left = ids(a),
    right = ids(b);
  if (identityProviders.some((key) => left[key] && right[key] && left[key] !== right[key]))
    return false;
  if (strong.some((key) => left[key] && left[key] === right[key])) return true;
  return anime.some((key) => left[key] && left[key] === right[key]);
}

// Presentation grouping only: retain every underlying record and media file.
// Matching titles alone never establishes series identity.
export function nativeCatalogView(input: NativeCatalogEntry[]) {
  const active = input.filter((e) => e.available);
  const aliases = new Map<string, string>();
  const paths = new Map<string, string>();
  const hidden = new Set<string>();
  const groups: NativeCatalogEntry[][] = [];
  const groupsByIdentity = new Map<string, Set<number>>();
  for (const entry of active
    .filter((e) => e.kind === "series" && !e.parent_path)
    .sort(
      (a, b) =>
        b.artwork.length - a.artwork.length || a.path.localeCompare(b.path),
    )) {
    const candidates = new Set<number>();
    const identifiers = ids(entry);
    for (const provider of identityProviders) {
      const value = identifiers[provider];
      if (value) for (const index of groupsByIdentity.get(`${provider}:${value}`) ?? []) candidates.add(index);
    }
    // Preserve the original first-compatible-group rule for partial identities.
    const compatible = [...candidates].sort((a, b) => a - b)
      .find(index => groups[index].every(member => sameSeries(member, entry)));
    const index = compatible ?? groups.length;
    if (compatible != null) groups[index].push(entry);
    else groups.push([entry]);
    for (const provider of identityProviders) {
      const value = identifiers[provider];
      if (!value) continue;
      const key = `${provider}:${value}`;
      let matches = groupsByIdentity.get(key);
      if (!matches) groupsByIdentity.set(key, matches = new Set());
      matches.add(index);
    }
  }
  for (const group of groups)
    for (const entry of group) {
      aliases.set(entry.id, group[0].id);
      paths.set(entry.path, group[0].path);
      if (entry !== group[0]) hidden.add(entry.id);
    }
  const groupedParents = new Set(groups.filter(group => group.length > 1).map(group => group[0].path));
  const seasons = new Map<string, NativeCatalogEntry>();
  for (const entry of active
    .filter((e) => e.kind === "season")
    .sort(
      (a, b) =>
        b.artwork.length - a.artwork.length || a.path.localeCompare(b.path),
    )) {
    const parent = entry.parent_path && paths.get(entry.parent_path);
    // Only combine seasons when their parent series were actually grouped.
    if (!parent || !groupedParents.has(parent))
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
