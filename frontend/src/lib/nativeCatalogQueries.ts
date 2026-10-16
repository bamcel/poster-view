import {useMemo, useRef} from "react";
import {useQueries} from "@tanstack/react-query";
import {nativeLibraries, type NativeLibrary, type NativeCatalogEntry} from "../api/nativeLibraries";
import {nativeCatalogView} from "./nativeCatalogView";

export const usesCatalogSummaries = (library: Pick<NativeLibrary, "library_type">) =>
  !["books", "youtube"].includes(library.library_type);

export function catalogQueryOptions(library: Pick<NativeLibrary, "id" | "library_type">) {
  const summary = usesCatalogSummaries(library);
  return {
    queryKey: summary ? ["native-catalog", library.id, "summary"] : ["native-catalog", library.id],
    queryFn: () => summary ? nativeLibraries.summaries(library.id) : nativeLibraries.catalog(library.id),
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
  };
}

const views = new WeakMap<NativeCatalogEntry[], ReturnType<typeof nativeCatalogView>>();
const empty: NativeCatalogEntry[] = [];

export function catalogView(entries: NativeCatalogEntry[] = empty) {
  let view = views.get(entries);
  if (!view) {
    view = nativeCatalogView(entries);
    views.set(entries, view);
  }
  return view;
}

// Expand only the viewed or edited records and their headers. Children retain
// enough summary data for navigation and playback without provider payloads.
export function useCatalogDetails(
  library: NativeLibrary,
  summaries: NativeCatalogEntry[] | undefined,
  ids: (string | undefined)[],
) {
  const requested = useMemo(() => {
    if (!usesCatalogSummaries(library)) return [];
    const view = catalogView(summaries);
    const byId = new Map(view.entries.map(entry => [entry.id, entry]));
    const byPath = new Map(view.entries.map(entry => [entry.path, entry]));
    const entries = new Map<string, NativeCatalogEntry>();
    for (const id of ids) {
      let entry = id ? byId.get(view.aliases.get(id) ?? id) : undefined;
      while (entry && !entries.has(entry.id)) {
        entries.set(entry.id, entry);
        entry = entry.parent_path ? byPath.get(entry.parent_path) : undefined;
      }
    }
    return [...entries.values()];
  }, [library.library_type, summaries, ids.join("\0")]);

  const details = useQueries({queries: requested.map(entry => ({
    queryKey: ["native-catalog", library.id, "item", entry.id],
    queryFn: () => nativeLibraries.item(library.id, entry.id),
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
  }))});
  const full = new Map(details.flatMap(query => query.data ? [[query.data.id, query.data] as const] : []));

  // useQueries can change length as navigation adds ancestors or an editor.
  // Compare data references to avoid regrouping the catalog for status updates.
  const previous = useRef<{
    summaries: NativeCatalogEntry[] | undefined;
    details: (NativeCatalogEntry | undefined)[];
    view: ReturnType<typeof nativeCatalogView>;
  } | undefined>(undefined);
  const current = details.map(query => query.data);
  if (!previous.current || previous.current.summaries !== summaries ||
    current.length !== previous.current.details.length ||
    current.some((entry, index) => entry !== previous.current!.details[index])) {
    previous.current = {
      summaries,
      details: current,
      view: full.size
        ? nativeCatalogView(summaries?.map(entry => full.get(entry.id) ?? entry) ?? [])
        : catalogView(summaries),
    };
  }

  return {
    view: previous.current.view,
    isReady: (id: string) => !usesCatalogSummaries(library) || full.has(id),
    pending: details.some(query => query.isPending),
    error: details.find(query => query.error)?.error,
    refetch: () => Promise.all(details.map(query => query.refetch())),
  };
}
