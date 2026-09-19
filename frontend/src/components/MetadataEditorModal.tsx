import { useEffect, useState, type FormEvent } from "react";
import { ExternalLink, Loader2, Save, X } from "lucide-react";
import type { NfoMetadata } from "../types";

export default function MetadataEditorModal({
  metadata,
  saving,
  error,
  onClose,
  onSave,
}: {
  metadata: NfoMetadata;
  saving: boolean;
  error?: string;
  onClose: () => void;
  onSave: (metadata: NfoMetadata) => void;
}) {
  const [fields, setFields] = useState(metadata);
  useEffect(() => {
    const close = (event: KeyboardEvent) => event.key === "Escape" && !saving && onClose();
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose, saving]);
  const set = (key: keyof NfoMetadata, value: string) => setFields((current) => ({ ...current, [key]: value }));
  const submit = (event: FormEvent) => { event.preventDefault(); onSave(fields); };
  const input = "mt-1 w-full rounded-lg border border-border bg-input px-3 py-2 text-sm text-white outline-none transition-colors focus:border-accent";

  return (
    <div className="fixed inset-0 z-[80] grid place-items-center bg-black/70 p-4 backdrop-blur-sm" onMouseDown={(event) => event.target === event.currentTarget && !saving && onClose()}>
      <form onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="metadata-editor-title" className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-surface shadow-2xl">
        <header className="flex items-center justify-between border-b border-border px-5 py-4">
          <div><h2 id="metadata-editor-title" className="text-lg font-semibold">Edit metadata</h2><p className="text-xs text-faint">Changes are saved directly to this title’s NFO file.</p></div>
          <button type="button" onClick={onClose} disabled={saving} aria-label="Close metadata editor" className="grid size-9 place-items-center rounded-lg text-muted hover:bg-elevated hover:text-white disabled:opacity-50"><X className="size-5" /></button>
        </header>
        <div className="grid gap-4 overflow-y-auto p-5 sm:grid-cols-2">
          <label className="text-sm text-muted sm:col-span-2">Title<input required className={input} value={fields.title} onChange={(e) => set("title", e.target.value)} /></label>
          <label className="text-sm text-muted sm:col-span-2">Original title<input className={input} value={fields.native_title} onChange={(e) => set("native_title", e.target.value)} /></label>
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
                      href={fields.source_url || `https://anilist.co/manga/${encodeURIComponent(fields.anilist_id)}`}
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
              <label className="text-sm text-muted">MyAnimeList ID<input className={input} value={fields.mal_id} onChange={(e) => set("mal_id", e.target.value)} /></label>
              <label className="text-sm text-muted">ComicVine ID<input className={input} value={fields.comicvine_id} onChange={(e) => set("comicvine_id", e.target.value)} /></label>
              <label className="text-sm text-muted sm:col-span-2">Source URL<input className={input} value={fields.source_url} onChange={(e) => set("source_url", e.target.value)} /></label>
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
