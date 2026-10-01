import type { QueryClient } from "@tanstack/react-query";
import type { ImageTarget } from "../types";
import type { NativeCatalogEntry } from "../api/nativeLibraries";

export function invalidateArtworkItems(client: QueryClient, serverId: number, itemId: string, target?: ImageTarget) {
  const native = serverId === 0 && itemId.startsWith("native:");
  const key = native ? ["native-catalog", itemId.split(":")[1]] : ["items", serverId];
  // The save has succeeded: show the fresh image immediately instead of waiting
  // for the full catalog and item-detail requests to finish.
  if (native && target) {
    const id = itemId.split(":").slice(2).join(":");
    client.setQueryData<NativeCatalogEntry[]>(key, entries => entries?.map(entry => {
      if (entry.id !== id) return entry;
      const kind = target === "background" ? "backdrop" : target === "poster" && entry.kind === "episode" ? "thumb" : target;
      const artwork = entry.artwork.some(art => art.kind === kind) ? entry.artwork : [...entry.artwork, {kind, path:"", source:"manual"}];
      return {...entry, artwork, revision:entry.revision + 1};
    }));
  }
  return client.invalidateQueries({queryKey:key});
}
