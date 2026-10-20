import { useEffect, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { nativeLibraries, type NativeLibrary } from "../api/nativeLibraries";
import { nativeArtworkVersion } from "../lib/nativeArtworkCache";
import { BACKDROP_OVERLAY_EVENT, backdropOverlay } from "../lib/dashboardSettings";
import { readYoutubeHomepagePreferences, useYoutubeHomepagePreferencesRevision } from "../lib/youtubeHomepagePreferences";
import DashboardBackdrop from "./DashboardBackdrop";

/** The page background is independent of the featured headline's artwork. */
export default function HomeBackground({ libraries, librariesLoading = false }: { libraries: NativeLibrary[]; librariesLoading?: boolean }) {
  useYoutubeHomepagePreferencesRevision();
  const [overlay, setOverlay] = useState(backdropOverlay);
  useEffect(() => {
    const update = () => setOverlay(backdropOverlay());
    window.addEventListener(BACKDROP_OVERLAY_EVENT, update);
    return () => {
      window.removeEventListener(BACKDROP_OVERLAY_EVENT, update);
    };
  }, []);
  const sources = libraries.filter(library => library.library_type !== "youtube" || readYoutubeHomepagePreferences(library.id).background);
  const catalogs = useQueries({ queries: sources.map(library => ({
    queryKey: ["native-catalog", library.id, "summary"],
    queryFn: () => nativeLibraries.summaries(library.id),
    staleTime: 5 * 60_000,
    gcTime: 5 * 60_000,
  })) });
  const urls = [...new Set(catalogs.flatMap((catalog, index) => (catalog.data ?? []).flatMap(entry => {
    if (!entry.available || entry.metadata.missing === true) return [];
    if (sources[index].library_type === "youtube" && (entry.kind !== "series" || entry.parent_path != null)) return [];
    const kind = entry.artwork.some(art => art.kind === "backdrop") ? "backdrop" : entry.artwork.some(art => art.kind === "fanart") ? "fanart" : null;
    return kind ? [`${nativeLibraries.artworkUrl(sources[index].id, entry.id, kind)}?v=${encodeURIComponent(nativeArtworkVersion(entry, kind))}`] : [];
  })))];
  const loading = librariesLoading || catalogs.some(catalog => catalog.isPending);
  if (urls.length === 0 && !loading) return null;
  return <DashboardBackdrop desktopUrls={urls} mobileUrls={urls} overlayStrength={overlay} cacheKey="home" loading={loading} allowedLibraryIds={librariesLoading ? undefined : sources.map(library => library.id)} />;
}
