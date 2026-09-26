import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { videoMetadataApi, type VideoDocument } from "../api/videoMetadata";

const groups: { title: string; fields: [string, string][] }[] = [
  { title: "Identity & description", fields: [["title", "Title"], ["originaltitle", "Original title"], ["sorttitle", "Sort title"], ["year", "Year"], ["plot", "Plot"], ["outline", "Outline"], ["tagline", "Tagline"]] },
  { title: "Details", fields: [["premiered", "Premiere date"], ["releasedate", "Release date"], ["enddate", "End date"], ["runtime", "Runtime (minutes)"], ["mpaa", "Content rating"], ["status", "Status"], ["rating", "Rating"], ["criticrating", "Critic rating"], ["customrating", "Custom rating"], ["language", "Language"]] },
  { title: "Classification & crew", fields: [["genre", "Genres"], ["tag", "Tags"], ["studio", "Studios"], ["country", "Countries"], ["director", "Directors"], ["credits", "Writing credits"], ["writer", "Writers"], ["trailer", "Trailer links"]] },
  { title: "Provider IDs", fields: [["imdbid", "IMDb ID"], ["tmdbid", "TMDB ID"], ["tvdbid", "TVDB ID"]] },
];
const multiline = new Set(["plot", "outline", ...groups[2].fields.map(([key]) => key)]);
const button = "rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-40";
const input = "mt-1 w-full rounded-lg border border-border bg-input px-3 py-2 text-sm text-white disabled:opacity-60";

export default function VideoMetadataEditor({ serverId, itemId, onClose }: { serverId: number; itemId: string; onClose: () => void }) {
  const [document, setDocument] = useState<VideoDocument>();
  const [fields, setFields] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<VideoDocument>();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const generation = useRef(0);
  const dirty = !!document && Object.keys(fields).some(key => fields[key] !== document.fields[key]);
  const changes = document ? groups.flatMap(group => group.fields).filter(([key]) => fields[key] !== document.fields[key]) : [];
  async function load(target?: string) {
    const current = ++generation.current;
    setBusy(true); setError(""); setPreview(undefined); setSaved(false);
    try {
      const next = await videoMetadataApi.get(serverId, itemId, target);
      if (generation.current === current) { setDocument(next); setFields(next.fields); }
    } catch (e) { if (generation.current === current) setError((e as Error).message); }
    finally { if (generation.current === current) setBusy(false); }
  }
  useEffect(() => { void load(); return () => { generation.current++; }; }, [serverId, itemId]); // eslint-disable-line react-hooks/exhaustive-deps
  function close() { if (busy) return; if (dirty) setConfirmClose(true); else onClose(); }
  useEffect(() => {
    const listener = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  });
  async function submit(save: boolean) {
    if (!document) return;
    setBusy(true); setError(""); setSaved(false);
    const request = { server_id: serverId, item_id: itemId, target: document.target, revision: document.revision, fields };
    try {
      const next = await (save ? videoMetadataApi.save(request) : videoMetadataApi.preview(request));
      if (save) { setDocument(next); setFields(next.fields); setPreview(undefined); setSaved(true); }
      else setPreview(next);
    } catch (e) { setError((e as Error).message); setPreview(undefined); }
    finally { setBusy(false); }
  }
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-3 backdrop-blur-sm">
    <section role="dialog" aria-modal="true" aria-label="Edit movie or series metadata" className="flex max-h-[92dvh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl">
      <header className="flex items-center justify-between border-b border-border p-4"><div><h2 className="text-lg font-semibold">Edit Metadata</h2><p className="text-xs text-muted">Existing Emby movie / series NFO</p></div><button className={button} disabled={busy} onClick={close} aria-label="Close metadata editor"><X className="size-5" /></button></header>
      <div className="space-y-5 overflow-y-auto p-4">
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        {saved && <p role="status" className="text-sm text-success">NFO saved. Refresh metadata in your media server to display the changes there.</p>}
        {busy && <p role="status" className="text-sm text-muted">Working…</p>}
        {document && <>
          <p className="break-all text-xs text-muted">{document.target}</p>
          {document.choices.length > 1 && <label className="block text-sm">NFO file<select aria-label="NFO file" className={input} disabled={busy || dirty} value={document.target.split(/[\\/]/).pop()} onChange={event => void load(event.target.value)}>{document.choices.map(name => <option key={name}>{name}</option>)}</select><span className="text-xs text-muted">Save or reload your edits before selecting another file.</span></label>}
          {!document.can_write && <p className="text-sm text-muted">Read-only. Enable NFO metadata for this server in Settings → Server Setup to edit.</p>}
          {groups.map(group => <fieldset disabled={busy || !document.can_write} key={group.title}><legend className="mb-3 font-medium">{group.title}</legend>{group.title === "Classification & crew" && <p className="mb-2 text-xs text-muted">One value per line.</p>}<div className="grid gap-3 sm:grid-cols-2">{group.fields.map(([key, label]) => <label key={key} className={`block text-xs text-muted ${key === "plot" ? "sm:col-span-2" : ""}`}>{label}{multiline.has(key) ? <textarea className={input} rows={key === "plot" ? 5 : 2} value={fields[key] ?? ""} onChange={e => { setFields({ ...fields, [key]: e.target.value }); setPreview(undefined); setSaved(false); }} /> : <input className={input} value={fields[key] ?? ""} onChange={e => { setFields({ ...fields, [key]: e.target.value }); setPreview(undefined); setSaved(false); }} />}</label>)}</div></fieldset>)}
          <details><summary className="cursor-pointer text-sm">Cast in this NFO ({document.actors.length})</summary><p className="my-2 text-xs text-muted">Preserved as stored. Language-specific cast from providers is managed in Cast & Crew.</p>{document.actors.map((actor, i) => <p key={i} className="text-sm">{actor.name}{actor.role && ` — ${actor.role}`}</p>)}</details>
          <details><summary className="cursor-pointer text-sm">Current NFO XML</summary><pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-black/30 p-3 text-xs">{document.xml}</pre></details>
          {preview && <section aria-label="Review NFO changes" className="space-y-3 rounded-lg border border-accent p-3"><h3 className="font-medium">Review changes</h3>{changes.map(([key, label]) => <div key={key} className="text-sm"><strong>{label}</strong><p className="whitespace-pre-wrap break-words text-muted">Before: {document.fields[key] || "(blank)"}</p><p className="whitespace-pre-wrap break-words">After: {preview.fields[key] || "(blank)"}</p></div>)}<details><summary className="cursor-pointer text-sm">Proposed NFO XML</summary><pre className="mt-2 whitespace-pre-wrap break-all text-xs">{preview.xml}</pre></details><p className="text-xs text-muted">Saving replaces this NFO. Other XML fields are retained; formatting may change.</p></section>}
        </>}
        {confirmClose && <div role="alert" className="flex flex-wrap items-center gap-3 text-sm"><p>Discard unsaved changes?</p><button className={button} onClick={onClose}>Discard and close</button><button className={button} onClick={() => setConfirmClose(false)}>Keep editing</button></div>}
      </div>
      <footer className="flex flex-wrap justify-end gap-2 border-t border-border p-4"><button className={button} disabled={busy} onClick={() => void load(document?.target.split(/[\\/]/).pop())}>{dirty ? "Discard edits and reload" : "Reload"}</button><button className={button} disabled={busy} onClick={close}>Close</button>{document?.can_write && <button className={`${button} bg-accent text-white`} disabled={busy || !dirty} onClick={() => void submit(!!preview)}>{preview ? "Save NFO" : "Review changes"}</button>}</footer>
    </section>
  </div>;
}
