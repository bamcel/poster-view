import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import type { MediaItem } from "../types";
import { readerRequest } from "../lib/reader";
import EditionField from "./EditionField";

type Result = { id: string; title: string; error?: string };
export default function BulkEditionEditor({ serverId, items, onClose }: { serverId: number; items: MediaItem[]; onClose: () => void }) {
  const client = useQueryClient();
  const dialog = useRef<HTMLDialogElement>(null);
  const stopped = useRef(false);
  const running = useRef(false);
  const [stage, setStage] = useState<"edit" | "review" | "running" | "results">("edit");
  const [clearEdition, setClearEdition] = useState(false);
  const [edition, setEdition] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [cancelled, setCancelled] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
    return () => { stopped.current = true; };
  }, []);
  async function apply(targets: MediaItem[]) {
    if (running.current) return;
    running.current = true;
    stopped.current = false;
    setCancelled(false);
    setStage("running");
    setResults(previous => previous.filter(result => !targets.some(item => item.id === result.id)));
    for (const item of targets) {
      if (stopped.current) break;
      try {
        await readerRequest("/api/metadata/edition", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ server_id: serverId, item_id: item.id, edition: clearEdition ? "" : edition.trim(), ...(clearEdition ? { clear: true } : {}) }) });
        setResults(previous => [...previous, { id: item.id, title: item.title }]);
        void client.invalidateQueries({ queryKey: ["nfo-metadata", serverId, item.id] });
        void client.invalidateQueries({ queryKey: ["item-detail", serverId, item.id] });
      } catch (error) {
        setResults(previous => [...previous, { id: item.id, title: item.title, error: error instanceof Error ? error.message : "Update failed." }]);
      }
    }
    void client.invalidateQueries({ queryKey: ["book-info"] });
    running.current = false;
    setStage("results");
  }
  const button = "rounded-lg border border-border px-4 py-2 text-sm disabled:opacity-40";
  const failures = items.filter(item => results.some(result => result.id === item.id && result.error));
  const remaining = items.filter(item => !results.some(result => result.id === item.id));
  return createPortal(<dialog ref={dialog} aria-label="Bulk Edit Metadata" onCancel={event => { event.preventDefault(); if (!running.current) onClose(); }} className="fixed inset-0 m-auto max-h-[85dvh] w-[min(36rem,calc(100vw-2rem))] overflow-y-auto rounded-2xl border border-border bg-sidebar p-6 text-white shadow-2xl backdrop:bg-black/60 backdrop:backdrop-blur-sm">
    <header className="flex items-center justify-between gap-4"><div><h2 className="text-lg font-semibold">Bulk Edit Metadata</h2><p className="mt-1 text-xs text-muted">{items.length} Book Series Selected</p></div><button type="button" aria-label="Close Bulk Edit" disabled={stage === "running"} className="rounded-lg p-2 disabled:opacity-40" onClick={onClose}><X className="size-5" /></button></header>
    {stage === "edit" && <section className="mt-6 space-y-4">
      <h3 className="text-sm font-semibold">Edition</h3>
      <EditionField value={edition} onChange={value => { setClearEdition(false); setEdition(value); }} remove={clearEdition} onRemove={() => setClearEdition(true)} emptyLabel="Not Set (No Changes)" inputClass="mt-2 w-full rounded-lg border border-border bg-input px-3 py-2 text-white" />
      <p className="text-xs text-muted">Only Edition will change. Titles, other metadata, and folder names remain untouched. Existing editions may differ; this replaces them with your chosen value.</p>
      <p className="text-xs text-muted">Not Set leaves existing editions unchanged. Remove Edition clears only the Edition field.</p>
      <button type="button" className={`${button} bg-accent text-black`} disabled={!clearEdition && (!edition.trim() || edition.trim().length > 200)} onClick={() => setStage("review")}>Review Changes</button>
    </section>}
    {stage === "review" && <section className="mt-6 space-y-4"><h3 className="text-sm font-semibold">Review Changes</h3>
      <p className="text-sm">{clearEdition ? <>Remove the Edition field from {items.length} series.</> : <>Set Edition to <strong>{edition.trim()}</strong> for {items.length} series.</>}</p>
      <p className="text-xs text-muted">Writes local NFO files in the media mount. NFO metadata must be enabled for this server. Missing or inaccessible NFOs will be skipped with an error. This does not push metadata to the connected server.</p>
      <ul className="max-h-48 space-y-2 overflow-y-auto rounded-lg border border-border p-3 text-sm">{items.map(item => <li key={item.id}>{item.title}</li>)}</ul>
      <div className="flex justify-end gap-2"><button className={button} onClick={() => setStage("edit")}>Back</button><button className={`${button} bg-accent text-black`} onClick={() => void apply(items)}>Apply Changes</button></div>
    </section>}
    {(stage === "running" || stage === "results") && <section className="mt-6 space-y-4"><h3 className="text-sm font-semibold">{stage === "running" ? "Updating Metadata" : "Results"}</h3>
      <p role="status" className="text-sm text-muted">{results.filter(result => !result.error).length} updated · {results.filter(result => result.error).length} failed · {remaining.length} remaining</p>
      <ul className="max-h-60 space-y-3 overflow-y-auto text-sm">{results.map(result => <li key={result.id}><span className="font-medium">{result.title}</span><p className={result.error ? "text-red-300" : "text-muted"}>{result.error ?? (clearEdition ? "Edition removed" : `Edition set to ${edition.trim()}`)}</p></li>)}</ul>
      {stage === "running" ? <button className={button} disabled={cancelled} onClick={() => { stopped.current = true; setCancelled(true); }}>Stop After Current Item</button> : <div className="flex flex-wrap justify-end gap-2">{failures.length > 0 && <button className={button} onClick={() => void apply(failures)}>Retry Failed</button>}{remaining.length > 0 && <button className={button} onClick={() => void apply(remaining)}>Continue Remaining</button>}<button className={button} onClick={onClose}>Done</button></div>}
    </section>}
  </dialog>, document.body);
}
