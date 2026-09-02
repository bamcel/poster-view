// The right-hand artwork panel. A provider selector across the top switches
// between ThePosterDB (rich title/set search) and the API-based providers
// (Fanart.tv / TheTVDB / AniList), which load the current item's artwork
// grouped by type.

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Images } from "lucide-react";
import { api } from "../api/client";
import type { ItemDetail } from "../types";
import PosterDBBody from "./PosterDBPanel";
import ArtworkBrowser from "./ArtworkBrowser";
import ManualUpload from "./ManualUpload";

interface Props {
  serverId: number;
  item: ItemDetail;
  prefill?: { term: string; nonce: number };
}

export default function ArtworkPanel({ serverId, item, prefill }: Props) {
  const [provider, setProvider] = useState("posterdb");
  const queryClient = useQueryClient();
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

  return (
    <div className="flex h-full flex-col border-l border-border bg-surface/90 backdrop-blur-xl">
      <div className="border-b border-border p-3">
        <h2 className="mb-2 flex items-center gap-2 px-1 text-sm font-semibold uppercase tracking-wide text-muted">
          <Images className="size-4 text-accent" /> Artwork
        </h2>
        <div className="flex flex-wrap gap-1">
          {tabs.map((t) => (
            <button
              key={t.name}
              onClick={() => setProvider(t.name)}
              onMouseEnter={() => {
                if (!["posterdb", "manual"].includes(t.name) && t.configured) {
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
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {provider === "posterdb" ? (
          <PosterDBBody serverId={serverId} item={item} prefill={prefill} />
        ) : provider === "manual" ? (
          <ManualUpload serverId={serverId} item={item} />
        ) : (
          <ArtworkBrowser provider={provider} serverId={serverId} item={item} />
        )}
      </div>
    </div>
  );
}
