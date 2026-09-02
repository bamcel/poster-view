// "Manual" artwork tab: apply your own image (uploaded file or a URL) to a
// chosen target — the item's poster/background, or a specific season's poster
// (including Season 0 / Specials). Reuses the same apply plumbing.

import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Upload, Loader2, ImageOff, Check } from "lucide-react";
import { api } from "../api/client";
import { useToast } from "../lib/toast";
import { buildApplyTargets } from "../lib/targets";
import type { ItemDetail } from "../types";

export default function ManualUpload({ serverId, item }: { serverId: number; item: ItemDetail }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState("");
  const [targetIndex, setTargetIndex] = useState(0);
  const [busy, setBusy] = useState(false);

  const targets = useMemo(() => buildApplyTargets(item), [item]);

  // Object URL for a chosen file (revoked on change).
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file) {
      setFileUrl(null);
      return;
    }
    const u = URL.createObjectURL(file);
    setFileUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  const preview = fileUrl ?? (url.trim() || null);

  const target = targets[targetIndex] ?? targets[0];
  const isBackground = target.target === "background";

  async function apply() {
    if (!file && !url.trim()) {
      toast.push("error", "Choose an image file or paste an image URL first.");
      return;
    }
    setBusy(true);
    try {
      const itemTitle = `${item.title} — ${target.label}`;
      const res = file
        ? await api.applyUpload({
            server_id: serverId,
            item_id: target.itemId,
            target: target.target,
            file,
            item_title: itemTitle,
          })
        : await api.applyPoster({
            server_id: serverId,
            item_id: target.itemId,
            target: target.target,
            provider: "url",
            download_url: url.trim(),
            item_title: itemTitle,
          });
      toast.push(res.ok ? "success" : "error", res.message);
      if (res.ok) {
        await queryClient.invalidateQueries({ queryKey: ["item-detail", serverId, item.id] });
        await queryClient.invalidateQueries({ queryKey: ["items", serverId] });
      }
    } catch (e) {
      toast.push("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* Image source */}
      <div>
        <label className="mb-1.5 block text-xs font-medium text-muted">Image</label>
        <label className="flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-surface-2 px-3 py-4 text-sm text-muted transition-colors hover:border-accent hover:text-white">
          <Upload className="size-4" />
          {file ? file.name : "Choose an image file…"}
          <input
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </label>
        <div className="mt-2 flex items-center gap-2">
          <span className="text-[11px] uppercase tracking-wide text-faint">or URL</span>
          <input
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              if (e.target.value) setFile(null);
            }}
            placeholder="https://…/image.jpg"
            className="min-w-0 flex-1 rounded-lg border border-border bg-surface-2 px-3 py-1.5 text-sm outline-none focus:border-accent"
          />
        </div>
      </div>

      {/* Target */}
      <div>
        <label className="mb-1.5 block text-xs font-medium text-muted">Apply as</label>
        <select
          value={targetIndex}
          onChange={(e) => setTargetIndex(Number(e.target.value))}
          className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-accent"
        >
          {targets.map((t, i) => (
            <option key={i} value={i}>
              {t.label}
            </option>
          ))}
        </select>
      </div>

      {/* Preview */}
      {preview ? (
        <div className="overflow-hidden rounded-lg border border-border bg-base">
          <img
            src={preview}
            alt="preview"
            className={`w-full bg-base ${isBackground ? "aspect-video object-cover" : "max-h-64 object-contain"}`}
          />
        </div>
      ) : (
        <div className="grid h-32 place-items-center rounded-lg border border-dashed border-border text-faint">
          <div className="flex flex-col items-center gap-1 text-xs">
            <ImageOff className="size-6" /> Preview
          </div>
        </div>
      )}

      <button
        onClick={apply}
        disabled={busy || (!file && !url.trim())}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent py-2.5 text-sm font-semibold text-black transition-colors hover:bg-accent-hover disabled:opacity-50"
      >
        {busy ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
        Apply to {target.label.replace(" — poster", "")}
      </button>
    </div>
  );
}
