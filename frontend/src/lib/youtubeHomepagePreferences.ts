import { useCallback, useSyncExternalStore } from "react";

const prefix = "posterview.youtubeHomepage.";
const changed = "posterview-youtube-homepage";
const key = (library: string) => `${prefix}${library}`;

export function readYoutubeHomepagePreferences(library: string): { featured: boolean; background: boolean } {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key(library)) ?? "null");
    if (value && typeof value === "object") {
      const saved = value as Record<string, unknown>;
      return { featured: saved.featured === true, background: saved.background === true };
    }
  } catch { /* Missing or invalid preferences keep YouTube artwork isolated. */ }
  return { featured: false, background: false };
}

function subscribe(notify: () => void) {
  const storage = (event: StorageEvent) => {
    if (event.key === null || event.key.startsWith(prefix)) notify();
  };
  window.addEventListener(changed, notify);
  window.addEventListener("storage", storage);
  return () => {
    window.removeEventListener(changed, notify);
    window.removeEventListener("storage", storage);
  };
}

export function useYoutubeHomepagePreferences(library: string) {
  const snapshot = useCallback(() => {
    const value = readYoutubeHomepagePreferences(library);
    return (value.featured ? 1 : 0) | (value.background ? 2 : 0);
  }, [library]);
  const value = useSyncExternalStore(subscribe, snapshot, () => 0);
  const update = useCallback((field: "featured" | "background", enabled: boolean) => {
    try {
      localStorage.setItem(key(library), JSON.stringify({ ...readYoutubeHomepagePreferences(library), [field]: enabled }));
    } catch { /* Storage can be unavailable in private browsing. */ }
    window.dispatchEvent(new Event(changed));
  }, [library]);
  return {
    featured: (value & 1) !== 0,
    background: (value & 2) !== 0,
    setFeatured: (enabled: boolean) => update("featured", enabled),
    setBackground: (enabled: boolean) => update("background", enabled),
  };
}

function revision() {
  try {
    const entries: string[] = [];
    for (let index = 0; index < localStorage.length; index++) {
      const name = localStorage.key(index);
      if (name?.startsWith(prefix)) entries.push(`${name}:${localStorage.getItem(name)}`);
    }
    return entries.sort().join("\n");
  } catch { return ""; }
}

export function useYoutubeHomepagePreferencesRevision(): string {
  return useSyncExternalStore(subscribe, revision, () => "");
}
