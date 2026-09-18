import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { ItemDetail } from "../types";
import { parseOwnedVolumes, volumeInventory } from "../lib/mangaCompleteness";

type Saved = { id?: number; total?: number; released?: number; finished?: boolean; owned?: string };
export default function MangaCompleteness({ serverId, item }: { serverId: number; item: ItemDetail }) {
  const storageKey = `posterview.manga-completeness.${serverId}.${item.id}`;
  const [saved, setSaved] = useState<Saved>(() => {
    try { return JSON.parse(localStorage.getItem(storageKey) ?? "{}"); } catch { return {}; }
  });
  const [search, setSearch] = useState(item.title);
  const [total, setTotal] = useState(saved.total?.toString() ?? "");
  const [released, setReleased] = useState(saved.released?.toString() ?? "");
  const [finished, setFinished] = useState(saved.finished ?? false);
  const [owned, setOwned] = useState(saved.owned ?? "");
  const [manual, setManual] = useState(saved.owned !== undefined);
  const [error, setError] = useState("");
  const lookup = useMutation({ mutationFn: () => api.mangaCatalog(search.trim()) });
  const matched = useQuery({ queryKey: ["manga-catalog", saved.id], queryFn: () => api.mangaCatalog("", saved.id), enabled: !!saved.id, staleTime: 24 * 60 * 60 * 1000, retry: false });
  const series = matched.data?.find(entry => entry.id === saved.id);
  const ended = saved.finished ?? series?.status === "FINISHED";
  const expected = ended ? saved.total ?? series?.volumes : saved.released ?? saved.total;
  const safeTotal = expected && Number.isInteger(expected) && expected > 0 && expected <= 2000 ? expected : undefined;
  const inventory = volumeInventory(item.members, safeTotal, item.title);
  const manualOwned = saved.owned !== undefined ? parseOwnedVolumes(saved.owned) : null;
  const volumes = manualOwned ?? inventory.owned;
  const missing = safeTotal ? Array.from({ length: safeTotal }, (_, i) => i + 1).filter(v => !volumes.includes(v)) : [];
  const uncertain = manualOwned !== null ? volumes.some(v => safeTotal && v > safeTotal) : inventory.uncertain > 0;
  const label = !safeTotal || uncertain || matched.isError && !saved.total && !saved.released ? "Unknown" : missing.length ? "Missing volumes" : ended ? "Complete" : "Up to date";
  function persist(value: Saved) {
    try { localStorage.setItem(storageKey, JSON.stringify(value)); setSaved(value); setError(""); }
    catch { setError("Could not save the collection settings in this browser."); }
  }
  const inputClass = "min-h-11 w-full rounded-lg border border-border bg-input px-3 py-2 text-sm";
  const buttonClass = "min-h-11 rounded-lg border border-border bg-button px-3 py-2 text-sm disabled:opacity-50";
  return <section className="mt-8 rounded-xl border border-border bg-surface/95 p-4">
    <h2 className="text-lg font-semibold">Manga volume collection</h2>
    <p className="mt-1 text-xs text-faint">Checks the volumes directly inside this folder. Use a folder containing only one manga series and edition.</p>
    <div role="status" aria-live="polite" className="mt-3 break-words">
      <p className="font-semibold">{label}{safeTotal ? ` · ${volumes.filter(v => v <= safeTotal).length} of ${safeTotal} volumes` : ` · ${volumes.length} numbered volumes detected`}</p>
      {safeTotal && missing.length > 0 && <p className="mt-1 text-sm">{uncertain ? "Not identified" : "Missing"}: {missing.join(", ")}</p>}
      {uncertain && <p className="mt-1 text-sm text-warning">Some files have unrecognized numbering or editions. Confirm the owned volumes below.</p>}
      {!ended && <p className="mt-1 text-sm text-faint">Enter the confirmed number of volumes released for this edition to check whether your collection is up to date.</p>}
      {series && <p className="mt-1 text-sm">Matched: <a className="underline" href={series.siteUrl} target="_blank" rel="noreferrer">{series.title.english ?? series.title.romaji ?? series.title.native}</a> · {series.status?.toLowerCase().replaceAll("_", " ")}</p>}
      {matched.isError && <p className="text-danger">{matched.error.message} <button className="underline" onClick={() => matched.refetch()}>Retry</button></p>}
    </div>
    <form className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-end" onSubmit={event => { event.preventDefault(); lookup.mutate(); }}>
      <label className="min-w-0 flex-1 text-xs">Find manga on AniList<input className={`mt-1 ${inputClass}`} value={search} onChange={e => setSearch(e.target.value)} maxLength={200} /></label>
      <button className={buttonClass} disabled={lookup.isPending || search.trim().length < 2}>{lookup.isPending ? "Searching…" : "Search manga"}</button>
    </form>
    {lookup.isError && <p role="alert" className="mt-2 text-sm text-danger">{lookup.error.message}</p>}
    {safeTotal && !ended && <p className="mt-2 text-xs text-faint">Compared with your manually confirmed released count; update it when new volumes release.</p>}
    {lookup.data && <div className="mt-2 space-y-2">
      {!lookup.data.length && <p className="text-sm">No matching manga found.</p>}
      {lookup.data.filter(entry => entry.format === "MANGA" || entry.format === "ONE_SHOT").map(entry => <button key={entry.id} type="button" className={`${buttonClass} w-full break-words text-left`} onClick={() => { persist({ ...saved, id: entry.id, total: undefined, released: undefined, finished: undefined }); setTotal(""); setReleased(""); setFinished(false); }}>
        Match {entry.title.english ?? entry.title.romaji ?? entry.title.native} · {entry.format} · {entry.status} · {entry.volumes ?? "Unknown"} volumes
      </button>)}
    </div>}
    <details className="mt-4">
      <summary className="cursor-pointer py-2 text-sm">Edition and volume overrides</summary>
      <p className="mt-2 text-xs text-faint">For omnibus editions, enter the original volumes covered. Overrides and the series match are saved for this server and folder in this browser.</p>
      <form className="mt-3 space-y-3" onSubmit={event => {
        event.preventDefault();
        const value = finished ? total : released;
        const count = value.trim() ? Number(value) : undefined;
        if (count !== undefined && (!Number.isInteger(count) || count < 1 || count > 2000)) { setError("Volume count must be between 1 and 2000."); return; }
        if (manual && (parseOwnedVolumes(owned) === null || (count && parseOwnedVolumes(owned)!.some(v => v > count)))) { setError("Enter owned volumes such as 1-3, 5, 7. They cannot exceed the expected total."); return; }
        persist({ id: saved.id, total: finished ? count : undefined, released: finished ? undefined : count, finished: count ? finished : undefined, owned: manual ? owned : undefined });
      }}>
        <label className="block text-xs">Released volumes so far (ongoing edition)<input type="number" min={1} max={2000} className={`mt-1 ${inputClass}`} value={released} onChange={e => setReleased(e.target.value)} disabled={finished} /></label>
        <label className="block text-xs">Expected volumes (leave blank to use AniList)<input type="number" min={1} max={2000} className={`mt-1 ${inputClass}`} value={total} onChange={e => setTotal(e.target.value)} disabled={!finished} /></label>
        <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={finished} onChange={e => setFinished(e.target.checked)} />This edition is finished</label>
        <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={manual} onChange={e => setManual(e.target.checked)} />Specify owned volumes manually</label>
        {manual && <label className="block text-xs">Owned volumes<input className={`mt-1 ${inputClass}`} placeholder="1-3, 5, 7" value={owned} onChange={e => setOwned(e.target.value)} /></label>}
        <button className={buttonClass}>Save collection settings</button>
        <button type="button" className={`ml-2 ${buttonClass}`} onClick={() => { persist({}); setTotal(""); setReleased(""); setFinished(false); setOwned(""); setManual(false); }}>Reset</button>
      </form>
    </details>
    {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
  </section>;
}
