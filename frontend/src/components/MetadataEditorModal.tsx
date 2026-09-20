import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ExternalLink, Loader2, Save, X } from "lucide-react";
import type { NfoMetadata } from "../types";

function mergeSourceUrls(existing: string, incoming: string): string {
  return [...new Set(`${existing}\n${incoming}`.split(/\r?\n/).map((url) => url.trim()).filter(Boolean))].join("\n");
}

function sourceUrlLabel(url: string): string {
  if (url.includes("anilist.co")) return "AniList";
  if (url.includes("comicvine.gamespot.com")) return "ComicVine";
  try { return new URL(url).hostname; } catch { return "Source"; }
}

function metadataValuesMatch(key: keyof NfoMetadata, current: string, incoming: string): boolean {
  if (key !== "status" && key !== "source_material") return current.trim() === incoming.trim();
  const normalize = (value: string) => value.trim().replaceAll("_", " ").replace(/\s+/g, " ").toLowerCase();
  return normalize(current) === normalize(incoming);
}

export default function MetadataEditorModal({
  metadata,
  saving,
  error,
  incoming,
  sourceLabel,
  onClose,
  onSave,
}: {
  metadata: NfoMetadata;
  saving: boolean;
  error?: string;
  incoming?: NfoMetadata;
  sourceLabel?: string;
  onClose: () => void;
  onSave: (metadata: NfoMetadata) => void;
}) {
  const conflicts = useMemo(() => {
    if (!incoming) return [] as Array<keyof NfoMetadata>;
    return (Object.keys(incoming) as Array<keyof NfoMetadata>).filter(
      (key) => key !== "source_url" && incoming[key].trim() && metadata[key].trim() && !metadataValuesMatch(key, metadata[key], incoming[key]),
    );
  }, [incoming, metadata]);
  const [fields, setFields] = useState<NfoMetadata>(() => {
    if (!incoming) return metadata;
    const merged = { ...metadata, source_url: mergeSourceUrls(metadata.source_url, incoming.source_url) };
    for (const key of Object.keys(incoming) as Array<keyof NfoMetadata>) {
      if (key === "source_url") continue;
      if (incoming[key].trim() && !metadata[key].trim()) merged[key] = incoming[key];
    }
    return merged;
  });
  const [overwrites, setOverwrites] = useState<Set<keyof NfoMetadata>>(new Set());
  const [appendDescription, setAppendDescription] = useState(false);
  useEffect(() => {
    const close = (event: KeyboardEvent) => event.key === "Escape" && !saving && onClose();
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose, saving]);
  const set = (key: keyof NfoMetadata, value: string) => setFields((current) => ({ ...current, [key]: value }));
  const sourceUrls = fields.source_url.split(/\r?\n/).map((url) => url.trim()).filter(Boolean);
  const displayedSourceUrls = sourceUrls.length ? sourceUrls : [""];
  const setSourceUrl = (index: number, value: string) => {
    const next = [...displayedSourceUrls];
    next[index] = value;
    set("source_url", next.map((url) => url.trim()).filter(Boolean).join("\n"));
  };
  const submit = (event: FormEvent) => { event.preventDefault(); onSave(fields); };
  const input = "mt-1 w-full rounded-lg border border-border bg-input px-3 py-2 text-sm text-white outline-none transition-colors focus:border-accent";
  const labels: Partial<Record<keyof NfoMetadata, string>> = {
    title: "Title", native_title: "Original title", translation: "Translation", year: "Year", publisher: "Publisher",
    volumes: "Volumes", status: "Status", plot: "Description", anilist_id: "AniList ID",
    mal_id: "MyAnimeList ID", comicvine_id: "ComicVine ID", source_url: "Source URLs",
    genres: "Genres", tags: "Tags", creators: "Creators", country: "Country",
    source_material: "Source material", edition: "Edition",
  };
  const chooseImported = (key: keyof NfoMetadata, useImported: boolean) => {
    if (key === "plot" && useImported) setAppendDescription(false);
    setOverwrites((current) => {
      const next = new Set(current);
      if (useImported) next.add(key); else next.delete(key);
      return next;
    });
    setFields((current) => ({ ...current, [key]: useImported ? incoming?.[key] ?? "" : metadata[key] }));
  };
  const chooseAppendedDescription = (append: boolean) => {
    setAppendDescription(append);
    setOverwrites((current) => {
      const next = new Set(current);
      next.delete("plot");
      return next;
    });
    setFields((current) => ({
      ...current,
      plot: append
        ? [metadata.plot.trim(), incoming?.plot.trim()].filter(Boolean).join("\n\n")
        : metadata.plot,
    }));
  };

  return (
    <div className="fixed inset-0 z-[80] grid place-items-center bg-black/70 p-4 backdrop-blur-sm" onMouseDown={(event) => event.target === event.currentTarget && !saving && onClose()}>
      <form onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="metadata-editor-title" className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-surface shadow-2xl">
        <header className="flex items-center justify-between border-b border-border px-5 py-4">
          <div><h2 id="metadata-editor-title" className="text-lg font-semibold">{incoming ? `Review ${sourceLabel ?? "imported"} metadata` : "Edit metadata"}</h2><p className="text-xs text-faint">Review the fields below, then save changes to this title’s NFO file.</p></div>
          <button type="button" onClick={onClose} disabled={saving} aria-label="Close metadata editor" className="grid size-9 place-items-center rounded-lg text-muted hover:bg-elevated hover:text-white disabled:opacity-50"><X className="size-5" /></button>
        </header>
        <div className="grid gap-4 overflow-y-auto p-5 sm:grid-cols-2">
          {incoming && conflicts.length > 0 && (
            <section className="space-y-2 rounded-xl border border-amber-400/25 bg-amber-400/5 p-3 sm:col-span-2">
              <div>
                <h3 className="text-sm font-semibold text-amber-200">Choose fields to overwrite</h3>
                <p className="text-xs text-faint">Existing NFO values are kept unless you select the imported value.</p>
              </div>
              {conflicts.map((key) => (
                <div key={key} className="rounded-lg border border-white/10 bg-black/10 p-3">
                  <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                    <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold text-white">
                      <input type="checkbox" checked={overwrites.has(key)} onChange={(event) => chooseImported(key, event.target.checked)} className="size-4 accent-[var(--color-accent)]" />
                      Overwrite {labels[key] ?? key}
                    </label>
                    {key === "plot" && (
                      <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold text-white">
                        <input type="checkbox" checked={appendDescription} onChange={(event) => chooseAppendedDescription(event.target.checked)} className="size-4 accent-[var(--color-accent)]" />
                        Append Description
                      </label>
                    )}
                  </div>
                  <span className="mt-2 block min-w-0 text-xs">
                    <span className="block break-words text-faint">Current: {metadata[key]}</span>
                    <span className="mt-1 block break-words text-amber-100">{sourceLabel ?? "Imported"}: {incoming[key]}</span>
                  </span>
                </div>
              ))}
            </section>
          )}
          <label className="text-sm text-muted sm:col-span-2">Title<input required className={input} value={fields.title} onChange={(e) => set("title", e.target.value)} /></label>
          <label className="text-sm text-muted sm:col-span-2">Original title<input className={input} value={fields.native_title} onChange={(e) => set("native_title", e.target.value)} /></label>
          <label className="text-sm text-muted sm:col-span-2">Translation<input className={input} value={fields.translation} onChange={(e) => set("translation", e.target.value)} /></label>
          <label className="text-sm text-muted">Year<input inputMode="numeric" className={input} value={fields.year} onChange={(e) => set("year", e.target.value)} /></label>
          <label className="text-sm text-muted">Status<input className={input} value={fields.status} onChange={(e) => set("status", e.target.value)} /></label>
          <label className="text-sm text-muted">Publisher<input className={input} value={fields.publisher} onChange={(e) => set("publisher", e.target.value)} /></label>
          <label className="text-sm text-muted">Volumes<input inputMode="numeric" className={input} value={fields.volumes} onChange={(e) => set("volumes", e.target.value)} /></label>
          <label className="text-sm text-muted">Country<input className={input} value={fields.country} onChange={(e) => set("country", e.target.value)} /></label>
          <label className="text-sm text-muted">Source material<input className={input} value={fields.source_material} onChange={(e) => set("source_material", e.target.value)} /></label>
          <label className="text-sm text-muted sm:col-span-2">Description<textarea rows={6} className={input} value={fields.plot} onChange={(e) => set("plot", e.target.value)} /></label>
          <details open className="sm:col-span-2 rounded-xl border border-border bg-window p-3">
            <summary className="cursor-pointer text-sm font-medium text-muted">Advanced fields</summary>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <label className="text-sm text-muted">Edition<input className={input} value={fields.edition} onChange={(e) => set("edition", e.target.value)} /></label>
              <label className="text-sm text-muted">
                AniList ID
                <span className="relative block">
                  <input className={`${input} pr-10`} value={fields.anilist_id} onChange={(e) => set("anilist_id", e.target.value)} />
                  {fields.anilist_id && (
                    <a
                      href={`https://anilist.co/manga/${encodeURIComponent(fields.anilist_id)}`}
                      target="_blank"
                      rel="noreferrer"
                      aria-label="Open this title on AniList"
                      title="Open on AniList"
                      className="absolute right-2 top-1/2 mt-0.5 grid size-7 -translate-y-1/2 place-items-center rounded-md text-muted transition-colors hover:bg-elevated hover:text-accent"
                    >
                      <ExternalLink className="size-4" />
                    </a>
                  )}
                </span>
              </label>
              <label className="text-sm text-muted">
                MyAnimeList ID
                <span className="relative block">
                  <input className={`${input} pr-10`} value={fields.mal_id} onChange={(e) => set("mal_id", e.target.value)} />
                  {fields.mal_id && (
                    <a
                      href={`https://myanimelist.net/manga/${encodeURIComponent(fields.mal_id)}`}
                      target="_blank"
                      rel="noreferrer"
                      aria-label="Open this title on MyAnimeList"
                      title="Open on MyAnimeList"
                      className="absolute right-2 top-1/2 mt-0.5 grid size-7 -translate-y-1/2 place-items-center rounded-md text-muted transition-colors hover:bg-elevated hover:text-accent"
                    >
                      <ExternalLink className="size-4" />
                    </a>
                  )}
                </span>
              </label>
              <label className="text-sm text-muted">
                ComicVine ID
                <span className="relative block">
                  <input className={`${input} pr-10`} value={fields.comicvine_id} onChange={(e) => set("comicvine_id", e.target.value)} />
                  {fields.comicvine_id && (
                    <a
                      href={`https://comicvine.gamespot.com/volume/4050-${encodeURIComponent(fields.comicvine_id)}/`}
                      target="_blank"
                      rel="noreferrer"
                      aria-label="Open this title on ComicVine"
                      title="Open on ComicVine"
                      className="absolute right-2 top-1/2 mt-0.5 grid size-7 -translate-y-1/2 place-items-center rounded-md text-muted transition-colors hover:bg-elevated hover:text-accent"
                    >
                      <ExternalLink className="size-4" />
                    </a>
                  )}
                </span>
              </label>
              {displayedSourceUrls.map((url, index) => (
                <label key={`${index}-${sourceUrlLabel(url)}`} className="text-sm text-muted sm:col-span-2">
                  {url ? `${sourceUrlLabel(url)} URL` : "Database URL"}
                  <span className="relative block">
                    <input className={`${input} pr-10`} value={url} onChange={(event) => setSourceUrl(index, event.target.value)} />
                    {/^https?:\/\//i.test(url) && (
                      <a href={url} target="_blank" rel="noreferrer" aria-label={`Open ${sourceUrlLabel(url)} URL`} title={`Open ${sourceUrlLabel(url)}`} className="absolute right-2 top-1/2 mt-0.5 grid size-7 -translate-y-1/2 place-items-center rounded-md text-muted transition-colors hover:bg-elevated hover:text-accent">
                        <ExternalLink className="size-4" />
                      </a>
                    )}
                  </span>
                </label>
              ))}
              <label className="text-sm text-muted sm:col-span-2">Genres<input className={input} value={fields.genres} onChange={(e) => set("genres", e.target.value)} /></label>
              <label className="text-sm text-muted sm:col-span-2">Tags<input className={input} value={fields.tags} onChange={(e) => set("tags", e.target.value)} /></label>
              <label className="text-sm text-muted sm:col-span-2">Creators<textarea rows={3} className={input} value={fields.creators} onChange={(e) => set("creators", e.target.value)} /></label>
            </div>
          </details>
          {error && <p role="alert" className="text-sm text-danger sm:col-span-2">{error}</p>}
        </div>
        <footer className="flex justify-end gap-2 border-t border-border px-5 py-4">
          <button type="button" onClick={onClose} disabled={saving} className="rounded-lg border border-border px-4 py-2 text-sm text-muted hover:text-white disabled:opacity-50">Cancel</button>
          <button type="submit" disabled={saving} className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-black hover:bg-accent-hover disabled:opacity-50">{saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} Save changes</button>
        </footer>
      </form>
    </div>
  );
}
