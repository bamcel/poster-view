import { invalidateArtworkItems } from "../lib/artworkTarget";
import { useMemo, useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { nativeLibraries } from "../api/nativeLibraries";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { buildApplyTargets, type ApplyTarget } from "../lib/targets";
import { useToast } from "../lib/toast";
import type { ItemDetail } from "../types";

interface Props {
  serverId: number;
  item: ItemDetail;
  includeFolderBackdrop?: boolean;
}

export default function RemoveArtwork({ serverId, item, includeFolderBackdrop = false }: Props) {
  const targets = useMemo(() => buildApplyTargets(item, includeFolderBackdrop), [includeFolderBackdrop, item]);
  const [busy, setBusy] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const toast = useToast();
  const libraryId = serverId === 0 && item.id.startsWith("native:") ? item.id.split(":")[1] : "";
  const catalog = useQuery({queryKey: ["native-catalog", libraryId], queryFn: () => nativeLibraries.catalog(libraryId), enabled: !!libraryId});
  const animated = (catalog.data ?? []).flatMap(entry => {
    const id = `native:${libraryId}:${entry.id}`;
    if (id !== item.id && !targets.some(target => target.itemId === id)) return [];
    return entry.artwork.filter(art => art.kind.endsWith("-animated")).map(art => ({id: entry.id, kind: art.kind, label: `${entry.title} · ${art.kind.replace("-animated", "")} animation`}));
  });
  const removeAnimation = async (id: string, kind: string, label: string) => {
    if (!window.confirm(`Remove ${label}? Its static artwork will be kept.`)) return;
    setBusy(`${id}:${kind}`);
    try {
      await nativeLibraries.removeVariant(libraryId, id, kind);
      await refresh();
      toast.push("success", "Animation removed. Static artwork kept.");
    } catch (error) { toast.push("error", (error as Error).message); }
    finally { setBusy(null); }
  };

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["item-detail", serverId, item.id] }),
      invalidateArtworkItems(queryClient, serverId, item.id),
    ]);
  };

  const remove = async (target: ApplyTarget) => {
    if (!window.confirm(`Remove ${target.label} artwork?`)) return;
    setBusy(`${target.itemId}:${target.target}`);
    try {
      const result = await api.removeArtwork({ server_id: serverId, item_id: target.itemId, target: target.target });
      toast.push(result.ok ? "success" : "error", result.message);
      if (result.ok) await refresh();
    } catch (error) {
      toast.push("error", (error as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const removeAll = async () => {
    if (!window.confirm(`Remove all static artwork targets for ${item.title}?`)) return;
    setBusy("all");
    let removed = 0;
    try {
      for (const target of targets) {
        const result = await api.removeArtwork({ server_id: serverId, item_id: target.itemId, target: target.target });
        if (!result.ok) throw new Error(`${target.label}: ${result.message}`);
        removed += 1;
      }
      await refresh();
      toast.push("success", `Removed artwork from ${removed} target${removed === 1 ? "" : "s"}.`);
    } catch (error) {
      toast.push("error", (error as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return <div className="space-y-4">
    <div>
      <h3 className="text-sm font-semibold">Remove artwork</h3>
      <p className="mt-1 text-xs leading-5 text-faint">Choose an artwork target below. Animated artwork can be removed separately while keeping static artwork.</p>
    </div>
    <button type="button" onClick={() => void removeAll()} disabled={busy !== null || targets.length === 0} className="flex min-h-10 w-full items-center justify-center gap-2 rounded-lg border border-danger/40 bg-danger/10 px-3 text-sm font-semibold text-danger hover:bg-danger/20 disabled:opacity-50">
      {busy === "all" ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />} Remove All
    </button>
    {animated.length > 0 && <div className="space-y-2">
      <h4 className="text-sm font-semibold">Animated artwork</h4>
      <p className="text-xs text-faint">Remove animations independently of static artwork.</p>
      {animated.map(art => <button key={`${art.id}:${art.kind}`} type="button" disabled={busy !== null} onClick={() => void removeAnimation(art.id, art.kind, art.label)} className="flex min-h-10 w-full items-center justify-between gap-3 rounded-lg border border-border bg-surface-2 px-3 text-left text-sm text-muted hover:border-danger/50 hover:text-white disabled:opacity-50">
        <span>{art.label}</span>{busy === `${art.id}:${art.kind}` ? <Loader2 className="size-4 shrink-0 animate-spin"/> : <Trash2 className="size-4 shrink-0"/>}
      </button>)}
    </div>}
    <div className="space-y-2">
      {targets.map((target) => {
        const key = `${target.itemId}:${target.target}`;
        return <button key={`${key}:${target.label}`} type="button" onClick={() => void remove(target)} disabled={busy !== null} className="flex min-h-10 w-full items-center justify-between gap-3 rounded-lg border border-border bg-surface-2 px-3 text-left text-sm text-muted hover:border-danger/50 hover:text-white disabled:opacity-50">
          <span>{target.label}</span>
          {busy === key ? <Loader2 className="size-4 shrink-0 animate-spin" /> : <Trash2 className="size-4 shrink-0" />}
        </button>;
      })}
    </div>
  </div>;
}
