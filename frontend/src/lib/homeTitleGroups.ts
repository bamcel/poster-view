import type {HomeTitle} from "../components/HomeDiscovery";

export type HomeTitleGroup = HomeTitle & {sources: HomeTitle[]};

const providers = new Set(["tvdb", "tmdb", "imdb", "anilist", "mal", "anidb"]);

function identifiers(title: HomeTitle): Map<string, string> {
  const raw = title.entry.metadata.identifiers;
  const result = new Map<string, string>();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return result;
  for (const [key, value] of Object.entries(raw)) {
    const provider = key.trim().toLowerCase();
    if (!providers.has(provider) || (typeof value !== "string" && typeof value !== "number")) continue;
    const id = String(value).trim().toLowerCase();
    if (id && id !== "0" && (typeof value !== "number" || Number.isFinite(value))) result.set(provider, id);
  }
  return result;
}

function fallbackKey(title: HomeTitle): string | undefined {
  const raw = title.entry.metadata.year;
  if (typeof raw !== "number" && (typeof raw !== "string" || !raw.trim())) return;
  const year = Number(raw);
  if (!Number.isInteger(year) || year < 1 || year > 9999) return;
  const name = title.entry.title.normalize("NFKC").trim().toLowerCase();
  return name ? JSON.stringify([title.entry.kind, name, year]) : undefined;
}

function playable(title: HomeTitle) {
  return title.entry.kind === "movie" && title.entry.available && title.entry.files.length > 0;
}

// Presentation only: retain original records so callers can select another library.
// Each pair must agree, preventing partial identifiers from bridging distinct titles.
export function groupHomeTitles(titles: readonly HomeTitle[]): HomeTitleGroup[] {
  const groups: HomeTitleGroup[] = [];
  const members: Map<string, string>[][] = [];
  const byIdentity = new Map<string, Set<number>>();
  const byFallback = new Map<string, number>();
  for (const title of titles) {
    const kind = title.entry.kind;
    if (kind !== "movie" && kind !== "series") {
      groups.push({...title, sources: [title]});
      members.push([]);
      continue;
    }
    const ids = identifiers(title);
    const candidates = new Set<number>();
    for (const [provider, id] of ids) {
      for (const index of byIdentity.get(`${kind}:${provider}:${id}`) ?? []) candidates.add(index);
    }
    const fallback = ids.size ? undefined : fallbackKey(title);
    const fallbackIndex = fallback === undefined ? undefined : byFallback.get(fallback);
    const matching = ids.size
      ? [...candidates].sort((a, b) => a - b).find(index => members[index].every(other => {
        let shared = false;
        for (const [provider, id] of ids) {
          const value = other.get(provider);
          if (value !== undefined && value !== id) return false;
          if (value === id) shared = true;
        }
        return shared;
      }))
      : fallbackIndex;
    const index = matching ?? groups.length;
    if (matching === undefined) {
      groups.push({...title, sources: [title]});
      members.push([ids]);
    } else {
      const group = groups[index];
      group.sources.push(title);
      members[index].push(ids);
      if (!playable(group) && playable(title)) {
        groups[index] = {...title, sources: group.sources};
      }
    }
    if (fallback !== undefined) byFallback.set(fallback, index);
    for (const [provider, id] of ids) {
      const key = `${kind}:${provider}:${id}`;
      let indexes = byIdentity.get(key);
      if (!indexes) byIdentity.set(key, indexes = new Set());
      indexes.add(index);
    }
  }
  return groups;
}
