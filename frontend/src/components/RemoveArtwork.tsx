import { useMemo, useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
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

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["item-detail", serverId, item.id] }),
      queryClient.invalidateQueries({ queryKey: ["items", serverId] }),
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
    if (!window.confirm(`Remove all exposed artwork for ${item.title}?`)) return;
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
      <p className="mt-1 text-xs leading-5 text-faint">Choose one artwork target, or remove every target listed below. This cannot be undone from PosterView.</p>
    </div>
    <button type="button" onClick={() => void removeAll()} disabled={busy !== null || targets.length === 0} className="flex min-h-10 w-full items-center justify-center gap-2 rounded-lg border border-danger/40 bg-danger/10 px-3 text-sm font-semibold text-danger hover:bg-danger/20 disabled:opacity-50">
      {busy === "all" ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />} Remove All
    </button>
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
