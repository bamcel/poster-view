import { Switch } from "./ui";
// The right-hand artwork panel. A provider selector across the top switches
// between ThePosterDB (rich title/set search) and the API-based providers
// (Fanart.tv / TheTVDB / AniList), which load the current item's artwork
// grouped by type.

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Images, RefreshCw } from "lucide-react";
import { api } from "../api/client";
import type { ItemDetail, Library, NfoMetadata } from "../types";
import PosterDBBody from "./PosterDBPanel";
import ArtworkBrowser from "./ArtworkBrowser";
import ManualUpload from "./ManualUpload";
import RemoveArtwork from "./RemoveArtwork";
import MangaDexPanel from "./MangaDexPanel";
import VizPanel from "./VizPanel";
import { useToast } from "../lib/toast";
import { artworkMediaKind, providerMatchesMediaKind } from "../lib/mediaKind";
import { BACKDROP_BLUR_EVENT, PANEL_OVERLAY_EVENT, PANEL_SOLIDITY_EVENT, backdropBlur, panelOverlay, panelSolidity, translucentPanelColor } from "../lib/dashboardSettings";

interface Props {
  serverId: number;
  item: ItemDetail;
  prefill?: { term: string; nonce: number };
  navigationTarget?: { provider: string; value: string; nonce: number };
  anilistMangaId?: string;
  libraryType?: Library["type"];
  libraryTitle?: string;
  onReviewMetadata?: (metadata: NfoMetadata, sourceLabel: string) => void;
}

const ARTWORK_LAYOUT_KEY = "posterview.artworkSourceLayout";
const PROVIDER_GROUPS = [
  { label: "TV & Movies", names: ["posterdb", "fanart", "tvdb", "anilist", "mediux"] },
  { label: "Comics & Manga", names: ["anilist-manga", "mangadex", "viz", "comicvine"] },
  { label: "Local", names: ["manual", "remove"] },
];

export default function ArtworkPanel({ serverId, item, prefill, navigationTarget, anilistMangaId, libraryType, libraryTitle, onReviewMetadata }: Props) {
  const [provider, setProvider] = useState("posterdb");
  const [sourceLayout, setSourceLayout] = useState<"list" | "compact">(() =>
    localStorage.getItem(ARTWORK_LAYOUT_KEY) === "compact" ? "compact" : "list",
  );
  const [refreshing, setRefreshing] = useState(false);
  const [panelVersion, setPanelVersion] = useState(0);
  const [panelSolid, setPanelSolid] = useState(panelSolidity);
  const [panelBlur, setPanelBlur] = useState(backdropBlur);
  const [panelOverlayStrength, setPanelOverlayStrength] = useState(panelOverlay);
  const [otherSourcesOpen, setOtherSourcesOpen] = useState(false);
  const queryClient = useQueryClient();
  const toast = useToast();

  useEffect(() => {
    const updateSolidity = (event: Event) => setPanelSolid((event as CustomEvent<number>).detail);
    const updateBlur = (event: Event) => setPanelBlur((event as CustomEvent<number>).detail);
    const updateOverlay = (event: Event) => setPanelOverlayStrength((event as CustomEvent<number>).detail);
    window.addEventListener(PANEL_SOLIDITY_EVENT, updateSolidity);
    window.addEventListener(BACKDROP_BLUR_EVENT, updateBlur);
    window.addEventListener(PANEL_OVERLAY_EVENT, updateOverlay);
    return () => {
      window.removeEventListener(PANEL_SOLIDITY_EVENT, updateSolidity);
      window.removeEventListener(BACKDROP_BLUR_EVENT, updateBlur);
      window.removeEventListener(PANEL_OVERLAY_EVENT, updateOverlay);
    };
  }, []);
  const providersQ = useQuery({ queryKey: ["artwork-providers"], queryFn: api.artworkProviders });
  const settingsQ = useQuery({ queryKey: ["artwork-settings"], queryFn: api.getArtworkSettings });
  const enabled = settingsQ.data?.enabled_providers ?? [];
  const mediaKind = artworkMediaKind(item.type, libraryType, libraryTitle);
  const defaultProvider = mediaKind === "book"
    ? settingsQ.data?.ereader_default_provider
    : settingsQ.data?.default_provider;

  // ThePosterDB first, the API providers from the backend, then Manual upload.
  // Apply history now lives on its own global page (see Layout's "History" nav
  // link) rather than a per-item tab here.
  const allTabs = [
    ...(enabled.includes("posterdb") ? [{ name: "posterdb", label: "ThePosterDB", configured: true, needs_key: false, enabled: true }] : []),
    ...(providersQ.data ?? []).filter((source) => source.enabled),
    { name: "manual", label: "Manual", configured: true, needs_key: false },
  ];
  const primaryTabs = allTabs.filter((source) => providerMatchesMediaKind(source.name, mediaKind))
    .sort((left, right) => left.name === defaultProvider ? -1 : right.name === defaultProvider ? 1 : 0);
  const otherKind = mediaKind === "book" ? "screen" : mediaKind === "screen" ? "book" : null;
  const otherTabs = otherKind
    ? allTabs.filter((source) => source.name !== "manual" && providerMatchesMediaKind(source.name, otherKind))
    : [];
  const primaryProviderTabs = primaryTabs.filter((tab) => tab.name !== "manual");
  const manualTab = primaryTabs.find((tab) => tab.name === "manual");
  const removeTab = { name: "remove", label: "Remove", configured: true, needs_key: false };
  const compactTabs = [...allTabs, removeTab];

  useEffect(() => {
    const preferred = defaultProvider;
    if (preferred && primaryTabs.some((tab) => tab.name === preferred)) setProvider(preferred);
    else if (provider !== "remove" && !allTabs.some((tab) => tab.name === provider)) setProvider(primaryTabs[0]?.name ?? "manual");
    setOtherSourcesOpen(false);
    // Reset to the configured default when a different library item opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id, defaultProvider, enabled.join(","), providersQ.data, mediaKind]);

  useEffect(() => {
    if (navigationTarget && allTabs.some((tab) => tab.name === navigationTarget.provider)) {
      setProvider(navigationTarget.provider);
      if (otherTabs.some((tab) => tab.name === navigationTarget.provider)) setOtherSourcesOpen(true);
    }
    // The nonce intentionally makes repeated clicks reopen the requested provider.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigationTarget?.nonce]);

  const refreshProvider = async () => {
    setRefreshing(true);
    try {
      const result = await api.refreshArtworkItem(serverId, item.id);
      queryClient.removeQueries({
        predicate: (query) =>
          query.queryKey.includes("artwork") && query.queryKey.includes(item.id),
      });
      queryClient.invalidateQueries({ queryKey: ["artwork-cache"] });
      setPanelVersion((value) => value + 1);
      toast.push(result.ok ? "success" : "error", result.message);
    } catch (error) {
      toast.push("error", (error as Error).message);
    } finally {
      setRefreshing(false);
    }
  };
  const chooseLayout = (layout: "list" | "compact") => {
    localStorage.setItem(ARTWORK_LAYOUT_KEY, layout);
    setSourceLayout(layout);
  };
  const sourceButton = (tab: (typeof allTabs)[number]) => (
    <button
      key={tab.name}
      onClick={() => setProvider(tab.name)}
      onMouseEnter={() => {
        if (!["posterdb", "manual", "mangadex", "viz", "comicvine"].includes(tab.name) && tab.configured) {
          queryClient.prefetchQuery({
            queryKey: ["artwork", tab.name, serverId, item.id, undefined],
            queryFn: () => api.getArtwork(tab.name, serverId, item.id),
            staleTime: 5 * 60_000,
          });
        }
      }}
      className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${provider === tab.name ? "bg-accent text-black" : "bg-surface-2 text-muted hover:text-white"}`}
      title={tab.needs_key && !tab.configured ? "Add an API key in Settings" : undefined}
    >
      {tab.label}
      {tab.needs_key && !tab.configured && <span className="ml-1 text-amber-400">•</span>}
    </button>
  );

  return (
    <div
      className="flex h-full flex-col border-l border-border"
      style={{ backgroundColor: translucentPanelColor("--color-surface", panelSolid, panelOverlayStrength), backdropFilter: `blur(${panelBlur}px)`, WebkitBackdropFilter: `blur(${panelBlur}px)` }}
    >
      <div className="border-b border-border p-3">
        <div className="mb-2 flex items-center justify-between gap-3 px-1">
          <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted">
            <Images className="size-4 text-accent" /> Artwork
          </h2>
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-muted">
              {sourceLayout === "list" ? "List" : "Compact"}
            </span>
            <Switch label="Compact artwork sources" checked={sourceLayout === "compact"} translucent
              onChange={() => chooseLayout(sourceLayout === "list" ? "compact" : "list")} />
          </div>
        </div>
        {sourceLayout === "list" ? (
          <div>
            <div className="flex flex-wrap gap-1">
              {primaryProviderTabs.map(sourceButton)}
              {manualTab && sourceButton(manualTab)}
              {sourceButton(removeTab)}
              {otherTabs.length > 0 && <button type="button" aria-label="Show more artwork databases" aria-expanded={otherSourcesOpen} onClick={() => setOtherSourcesOpen((open) => !open)} className="flex items-center gap-1 rounded-full bg-surface-2 px-2 py-1 text-xs font-medium text-muted transition-colors hover:text-white">
                <span>Show More</span>
                <ChevronDown className={`size-4 transition-transform ${otherSourcesOpen ? "rotate-180" : ""}`} />
              </button>}
            </div>
            {otherSourcesOpen && otherTabs.length > 0 && <div className="mt-2 border-t border-border pt-2">
              <div className="flex flex-wrap gap-1">{otherTabs.map(sourceButton)}</div>
            </div>}
          </div>
        ) : (
          <label className="block text-xs text-faint">
            <span className="sr-only">Artwork source</span>
            <select
              aria-label="Artwork source"
              value={provider}
              onChange={(event) => setProvider(event.target.value)}
              className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-white outline-none focus:border-accent"
            >
              {PROVIDER_GROUPS.map((group) => {
                const options = group.names.flatMap((name) => compactTabs.filter((tab) => tab.name === name));
                return options.length ? (
                  <optgroup key={group.label} label={group.label}>
                    {options.map((option) => (
                      <option key={option.name} value={option.name}>
                        {option.label}{option.needs_key && !option.configured ? " · setup required" : ""}
                      </option>
                    ))}
                  </optgroup>
                ) : null;
              })}
            </select>
          </label>
        )}
      </div>

      <div className="scrollbar-hidden min-h-0 flex-1 overflow-y-auto p-4">
        {provider !== "manual" && provider !== "remove" && (
          <div className="mb-3 flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">
              {allTabs.find((tab) => tab.name === provider)?.label ?? provider}
            </h3>
            <button
              type="button"
              aria-label={`Refresh ${allTabs.find((tab) => tab.name === provider)?.label ?? provider} cache`}
              title="Refresh artwork cache"
              disabled={refreshing}
              onClick={() => void refreshProvider()}
              className="shrink-0 rounded-md p-2 text-muted transition-colors hover:bg-elevated hover:text-white disabled:opacity-50"
            >
              <RefreshCw className={`size-4 ${refreshing ? "animate-spin" : ""}`} />
            </button>
          </div>
        )}
        {provider === "posterdb" ? (
          <PosterDBBody key={panelVersion} serverId={serverId} item={item} prefill={prefill} />
        ) : provider === "mangadex" ? (
          <MangaDexPanel key={`${serverId}:${item.id}:${panelVersion}`} serverId={serverId} item={item} onManual={() => setProvider("manual")} />
        ) : provider === "viz" ? (
          <VizPanel key={`${serverId}:${item.id}:${panelVersion}`} serverId={serverId} item={item} prefill={navigationTarget?.provider === "viz" ? navigationTarget : undefined} onReviewMetadata={onReviewMetadata} />
        ) : provider === "comicvine" ? (
          <VizPanel key={`${serverId}:${item.id}:${panelVersion}`} serverId={serverId} item={item} database="comicvine" prefill={navigationTarget?.provider === "comicvine" ? navigationTarget : undefined} onReviewMetadata={onReviewMetadata} />
        ) : provider === "manual" ? (
          <ManualUpload serverId={serverId} item={item} includeFolderBackdrop={mediaKind === "book"} />
        ) : provider === "remove" ? (
          <RemoveArtwork serverId={serverId} item={item} includeFolderBackdrop={mediaKind === "book"} />
        ) : (
          <ArtworkBrowser key={panelVersion} provider={provider} serverId={serverId} item={item} metadataId={provider === "anilist-manga" ? anilistMangaId : undefined} prefill={navigationTarget?.provider === provider ? navigationTarget : undefined} onReviewMetadata={onReviewMetadata} />
        )}
      </div>
    </div>
  );
}
