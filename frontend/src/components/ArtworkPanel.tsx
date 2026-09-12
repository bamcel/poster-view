// The right-hand artwork panel. A provider selector across the top switches
// between ThePosterDB (rich title/set search) and the API-based providers
// (Fanart.tv / TheTVDB / AniList), which load the current item's artwork
// grouped by type.

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Images, RefreshCw } from "lucide-react";
import { api } from "../api/client";
import type { ItemDetail } from "../types";
import PosterDBBody from "./PosterDBPanel";
import ArtworkBrowser from "./ArtworkBrowser";
import ManualUpload from "./ManualUpload";
import MangaDexPanel from "./MangaDexPanel";
import VizPanel from "./VizPanel";
import { useToast } from "../lib/toast";

interface Props {
  serverId: number;
  item: ItemDetail;
  prefill?: { term: string; nonce: number };
}

const ARTWORK_LAYOUT_KEY = "posterview.artworkSourceLayout";
const PROVIDER_GROUPS = [
  { label: "General", names: ["posterdb", "fanart", "tvdb", "mediux"] },
  { label: "Anime & Manga", names: ["anilist", "mangadex", "viz"] },
  { label: "Local", names: ["manual"] },
];

export default function ArtworkPanel({ serverId, item, prefill }: Props) {
  const [provider, setProvider] = useState("posterdb");
  const [sourceLayout, setSourceLayout] = useState<"list" | "compact">(() =>
    localStorage.getItem(ARTWORK_LAYOUT_KEY) === "compact" ? "compact" : "list",
  );
  const [refreshing, setRefreshing] = useState(false);
  const [panelVersion, setPanelVersion] = useState(0);
  const queryClient = useQueryClient();
  const toast = useToast();
  const providersQ = useQuery({ queryKey: ["artwork-providers"], queryFn: api.artworkProviders });
  const settingsQ = useQuery({ queryKey: ["artwork-settings"], queryFn: api.getArtworkSettings });
  const enabled = settingsQ.data?.enabled_providers ?? [];

  // ThePosterDB first, the API providers from the backend, then Manual upload.
  // Apply history now lives on its own global page (see Layout's "History" nav
  // link) rather than a per-item tab here.
  const tabs = [
    ...(enabled.includes("posterdb") ? [{ name: "posterdb", label: "ThePosterDB", configured: true, needs_key: false, enabled: true }] : []),
    ...(providersQ.data ?? []).filter((source) => source.enabled),
    { name: "manual", label: "Manual", configured: true, needs_key: false },
  ].sort((left, right) => left.name === settingsQ.data?.default_provider ? -1 : right.name === settingsQ.data?.default_provider ? 1 : 0);

  useEffect(() => {
    const preferred = settingsQ.data?.default_provider;
    if (preferred && tabs.some((tab) => tab.name === preferred)) setProvider(preferred);
    else if (!tabs.some((tab) => tab.name === provider)) setProvider(tabs[0]?.name ?? "manual");
    // Reset to the configured default when a different library item opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id, settingsQ.data?.default_provider, enabled.join(","), providersQ.data]);

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

  return (
    <div className="flex h-full flex-col border-l border-border bg-surface/90 backdrop-blur-xl">
      <div className="border-b border-border p-3">
        <div className="mb-2 flex items-center justify-between gap-3 px-1">
          <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted">
            <Images className="size-4 text-accent" /> Artwork
          </h2>
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-muted">
              {sourceLayout === "list" ? "List" : "Compact"}
            </span>
            <button
              type="button"
              role="switch"
              aria-label="Compact artwork sources"
              aria-checked={sourceLayout === "compact"}
              onClick={() => chooseLayout(sourceLayout === "list" ? "compact" : "list")}
              className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${sourceLayout === "compact" ? "bg-accent" : "bg-surface-2"}`}
            >
              <span
                className={`inline-block size-3.5 rounded-full bg-white shadow-sm transition-transform ${sourceLayout === "compact" ? "translate-x-[1.125rem]" : "translate-x-1"}`}
              />
            </button>
          </div>
        </div>
        {sourceLayout === "list" ? (
          <div className="flex flex-wrap gap-1">
            {tabs.map((t) => (
              <button
                key={t.name}
                onClick={() => setProvider(t.name)}
                onMouseEnter={() => {
                  if (!["posterdb", "manual", "mangadex", "viz"].includes(t.name) && t.configured) {
                    queryClient.prefetchQuery({
                      queryKey: ["artwork", t.name, serverId, item.id, undefined],
                      queryFn: () => api.getArtwork(t.name, serverId, item.id),
                      staleTime: 5 * 60_000,
                    });
                  }
                }}
                className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  provider === t.name
                    ? "bg-accent text-black"
                    : "bg-surface-2 text-muted hover:text-white"
                }`}
                title={t.needs_key && !t.configured ? "Add an API key in Settings" : undefined}
              >
                {t.label}
                {t.needs_key && !t.configured && <span className="ml-1 text-amber-400">•</span>}
              </button>
            ))}
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
                const options = group.names.flatMap((name) => tabs.filter((tab) => tab.name === name));
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

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {provider !== "manual" && (
          <div className="mb-3 flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">
              {tabs.find((tab) => tab.name === provider)?.label ?? provider}
            </h3>
            <button
              type="button"
              aria-label={`Refresh ${tabs.find((tab) => tab.name === provider)?.label ?? provider} cache`}
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
          <VizPanel key={`${serverId}:${item.id}:${panelVersion}`} serverId={serverId} item={item} />
        ) : provider === "manual" ? (
          <ManualUpload serverId={serverId} item={item} />
        ) : (
          <ArtworkBrowser key={panelVersion} provider={provider} serverId={serverId} item={item} />
        )}
      </div>
    </div>
  );
}
