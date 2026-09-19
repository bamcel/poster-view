import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, FileText, FolderOpen, RefreshCw } from "lucide-react";
import { metadataApi, type MetadataDocument, type MetadataFields } from "../api/metadata";

const button = "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-border bg-elevated px-4 py-2 text-sm hover:bg-input-hover disabled:opacity-50";
const input = "mt-1 min-h-11 w-full min-w-0 rounded-lg border border-border bg-input px-3 py-2 text-sm focus:border-accent";
const panel = "min-w-0 rounded-xl border border-border bg-surface p-4 sm:p-5";

function plainSynopsis(value: string) {
  // AniList can still return HTML even when asHtml:false is requested.
  const parsed = new DOMParser().parseFromString(value.replace(/<br\s*\/?\s*>/gi, "\n"), "text/html");
  parsed.querySelectorAll("script, style").forEach(node => node.remove());
  return parsed.body.textContent?.trim() ?? "";
}

export default function MetadataPage() {
  const [path, setPath] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [checked, setChecked] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<string[]>([]);
  const client = useQueryClient();
  const folders = useQuery({ queryKey: ["metadata-folders", path], queryFn: () => metadataApi.folders(path), retry: false });
  const candidates = folders.data?.folders.filter(f => !f.has_nfo && f.name.toLowerCase().includes(filter.toLowerCase())) ?? [];
  const canLeave = () => !dirty || window.confirm("Discard unsaved metadata edits?");
  const browse = (next: string) => {
    if (!canLeave()) return;
    setPath(next); setSelected(null); setChecked([]); setFilter(""); setDirty(false); setReport([]);
  };
  async function createMissing() {
    if (!window.confirm(`Create ${checked.length} folder-named NFO file(s) in the selected folders using folder names as titles? Other metadata fields will be blank. Existing files will be skipped.`)) return;
    setBusy(true); setReport([]);
    const results: string[] = [];
    try {
      // Sequential writes keep large batches responsive and report partial failures.
      for (const folder of checked) {
        try {
          const document = await metadataApi.read(folder);
          if (document.revision !== null) {
            results.push(`${folder}: skipped — already exists.`);
          } else {
            await metadataApi.save({ path: folder, fields: document.fields, revision: null });
            results.push(`${folder}: NFO created.`);
          }
        } catch (error) { results.push(`${folder}: ${(error as Error).message}`); }
        setReport([...results]);
      }
    } finally {
      setBusy(false); setChecked([]);
      void client.invalidateQueries({ queryKey: ["metadata-folders"] });
      void client.invalidateQueries({ queryKey: ["metadata-document"] });
    }
  }
  return <div className="h-full overflow-y-auto p-4 sm:p-6">
    <div className="mx-auto max-w-7xl space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div><h1 className="text-xl font-semibold">Manga metadata</h1><p className="mt-1 text-sm text-muted">Read and save folder-named NFO files beside your manga. Choose a folder containing one series and edition.</p></div>
        <button className={button} disabled={busy} onClick={() => void folders.refetch()}><RefreshCw size={16} /> Refresh folders</button>
      </header>
      <div className="rounded-lg border border-border bg-surface-2 p-3 text-sm text-muted">
        <p className="break-all">Media root: <code>{folders.data?.root ?? "/media"}</code></p>
        <p className="mt-1">Mount your manga folder here with write access. These are local folders, independent of the selected media server. PosterView reads this NFO format; media-server support varies.</p>
      </div>
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(280px,0.8fr)_minmax(0,1.6fr)]">
        <section className={panel} aria-label="Manga folders">
          <div className="mb-4 flex flex-wrap items-center gap-2">
            {path && <button className={button} disabled={busy} onClick={() => browse(path.split("/").slice(0, -1).join("/"))}><ArrowLeft size={16} /> Up</button>}
            <h2 className="min-w-0 break-all font-semibold">{path || "Mounted folders"}</h2>
          </div>
          <label className="text-sm">Filter folders<input className={input} value={filter} onChange={e => setFilter(e.target.value)} /></label>
          {folders.isPending && <p className="mt-4 text-sm" role="status">Reading folders…</p>}
          {folders.error && <p className="mt-4 break-words text-sm text-red-300" role="alert">{folders.error.message}</p>}
          {folders.data?.folders.length === 0 && <p className="mt-4 text-sm text-muted">No subfolders found. Mount the parent folder that contains your manga series.</p>}
          {candidates.length > 0 && <label className="mt-3 flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" disabled={busy} checked={candidates.every(f => checked.includes(f.path))} onChange={e => setChecked(e.target.checked ? [...new Set([...checked, ...candidates.map(f => f.path)])] : checked.filter(p => !candidates.some(f => f.path === p)))} /> Select visible folders missing NFO</label>}
          <div className="mt-2 max-h-[32rem] space-y-2 overflow-y-auto">
            {folders.data?.folders.filter(f => f.name.toLowerCase().includes(filter.toLowerCase())).map(folder => <div key={folder.path} className={`flex items-center gap-2 rounded-lg border p-2 ${selected === folder.path ? "border-accent bg-selected" : "border-border"}`}>
              {!folder.has_nfo && <label className="grid min-h-11 min-w-8 place-items-center"><input aria-label={`Select ${folder.name}`} type="checkbox" disabled={busy} checked={checked.includes(folder.path)} onChange={e => setChecked(e.target.checked ? [...checked, folder.path] : checked.filter(p => p !== folder.path))} /></label>}
              <button disabled={busy} className="min-h-11 min-w-0 flex-1 text-left" onClick={() => { if (selected === folder.path || !canLeave()) return; setSelected(folder.path); setDirty(false); }}><span className="block break-words text-sm font-medium">{folder.name}</span><span className="text-xs text-muted">{folder.has_nfo ? "NFO found" : "No NFO"}</span></button>
              <button disabled={busy} className="grid size-11 shrink-0 place-items-center rounded-lg hover:bg-elevated" aria-label={`Browse inside ${folder.name}`} onClick={() => browse(folder.path)}><FolderOpen size={18} /></button>
            </div>)}
          </div>
          <button className={`${button} mt-4 w-full`} disabled={busy || !checked.length || dirty} onClick={() => void createMissing()}>{busy ? "Creating files…" : `Create ${checked.length || "selected"} missing NFOs`}</button>
          <p className="mt-2 text-xs text-muted">Bulk creation uses folder titles only. Select series folders, not library or grouping folders. Review metadata individually before adding edition details.</p>
          {!!report.length && <ul className="mt-3 max-h-48 space-y-1 overflow-y-auto break-words text-xs text-muted" aria-live="polite">{report.map(line => <li key={line}>{line}</li>)}</ul>}
        </section>
        {selected ? <MetadataEditor key={selected} path={selected} onDirty={setDirty} /> : <section className={`${panel} py-14 text-center text-muted`}><FileText className="mx-auto mb-3" /><h2 className="font-semibold">Select a manga series</h2><p className="mt-2 text-sm">Review its metadata and preview exactly what will be saved in its NFO file.</p></section>}
      </div>
    </div>
  </div>;
}

function MetadataEditor({ path, onDirty }: { path: string; onDirty: (value: boolean) => void }) {
  const document = useQuery({ queryKey: ["metadata-document", path], queryFn: () => metadataApi.read(path), retry: false, staleTime: Infinity, refetchOnWindowFocus: false });
  if (document.isPending) return <section className={panel} role="status">Reading metadata…</section>;
  if (document.error) return <section className={panel}><p role="alert">{document.error.message}</p><button className={`${button} mt-3`} onClick={() => void document.refetch()}>Reload metadata</button></section>;
  return <MetadataForm key={document.dataUpdatedAt} initial={document.data} onDirty={onDirty} />;
}

function MetadataForm({ initial, onDirty }: { initial: MetadataDocument; onDirty: (value: boolean) => void }) {
  const [document, setDocument] = useState(initial);
  const [fields, setFields] = useState(initial.fields);
  const [query, setQuery] = useState(initial.fields.title);
  const [preview, setPreview] = useState<MetadataDocument | null>(null);
  const [saved, setSaved] = useState(false);
  const client = useQueryClient();
  function update(next: MetadataFields) { setFields(next); setPreview(null); setSaved(false); onDirty(true); }
  const lookup = useMutation({ mutationFn: () => metadataApi.search(query) });
  const prepare = useMutation({ mutationFn: () => metadataApi.preview({ path: document.path, fields, revision: document.revision }), onSuccess: setPreview });
  const save = useMutation({ mutationFn: () => metadataApi.save({ path: document.path, fields: preview!.fields, revision: preview!.revision }), onSuccess: result => {
    setDocument(result); setPreview(null); setSaved(true); onDirty(false);
    void client.invalidateQueries({ queryKey: ["metadata-folders"] });
  } });
  const pending = save.isPending || prepare.isPending;
  return <section className={panel} aria-label="Series metadata editor">
    <h2 className="break-words text-lg font-semibold">{document.revision === null ? "Create" : "Edit"} {document.path.split("/").at(-1)}.nfo</h2>
    <p className="mt-1 break-all text-xs text-muted">{document.target}</p>
    <div className="my-4 rounded-lg border border-border p-3">
      <form className="flex flex-wrap items-end gap-2" onSubmit={e => { e.preventDefault(); lookup.mutate(); }}>
        <label className="min-w-0 flex-1 text-sm">Find manga on AniList<input className={input} value={query} onChange={e => setQuery(e.target.value)} /></label>
        <button className={button} disabled={lookup.isPending || query.trim().length < 2}>{lookup.isPending ? "Searching…" : "Search"}</button>
      </form>
      <p className="mt-2 text-xs text-muted">Matches describe the original work. Publisher, edition, and edition volumes stay as entered below. Publication status may differ for your edition.</p>
      {lookup.error && <p role="alert" className="mt-2 text-sm text-red-300">{lookup.error.message}</p>}
      {lookup.data?.length === 0 && <p className="mt-2 text-sm">No manga matches found.</p>}
      <div className="mt-2 space-y-2">{lookup.data?.map(match => <button key={match.anilist_id} disabled={pending} className={`${button} w-full justify-start text-left`} onClick={() => { update({ ...fields, title: match.title, year: match.year, plot: plainSynopsis(match.plot), status: match.status, anilist_id: match.anilist_id }); lookup.reset(); }}><span>{match.title}<span className="block text-xs text-muted">{match.year || "Year unknown"} · {match.status || "Status unknown"} · AniList {match.anilist_id}</span></span></button>)}</div>
    </div>
    <form onSubmit={e => { e.preventDefault(); prepare.mutate(); }}>
      <fieldset disabled={pending} className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
        {([ ["title", "Title"], ["year", "Year"], ["publisher", "Publisher"], ["edition", "Edition"], ["volumes", "Edition volumes (confirmed total)"], ["anilist_id", "AniList ID"] ] as const).map(([key, label]) => <label className="min-w-0 text-sm" key={key}>{label}<input className={input} required={key === "title"} type={["year", "volumes", "anilist_id"].includes(key) ? "number" : "text"} min="1" step="1" list={key === "edition" ? "edition-suggestions" : undefined} value={fields[key]} onChange={e => update({ ...fields, [key]: e.target.value })} /></label>)}
        <datalist id="edition-suggestions"><option value="Original" /><option value="Color" /></datalist>
        <label className="text-sm">Publication status<select className={input} value={fields.status} onChange={e => update({ ...fields, status: e.target.value })}>{[...new Set(["", "Completed", "Ongoing", "Hiatus", "Cancelled", "Not yet released", fields.status])].map(status => <option key={status} value={status}>{status || "Unknown"}</option>)}</select></label>
        <label className="text-sm sm:col-span-2">Synopsis<textarea rows={5} className={input} value={fields.plot} onChange={e => update({ ...fields, plot: e.target.value })} /></label>
      </fieldset>
      <p className="mt-3 text-xs text-muted">Leave unverified fields blank. Edition accepts Original, Color, or your own label. Volume counts are never inferred from files or a different edition.</p>
      <button className={`${button} mt-4`} disabled={pending}>{prepare.isPending ? "Preparing…" : "Preview NFO"}</button>
    </form>
    {(prepare.error || save.error) && <p role="alert" className="mt-3 text-sm text-red-300">{(prepare.error || save.error)?.message} <button className="underline" onClick={() => { if (window.confirm("Reload from disk and discard unsaved edits?")) { onDirty(false); void client.invalidateQueries({ queryKey: ["metadata-document", document.path] }); } }}>Reload from disk</button></p>}
    {preview && <div className="mt-4 space-y-3">
      <h3 className="font-medium">Ready to {preview.revision === null ? "create" : "update"} NFO</h3>
      <pre className="max-h-80 overflow-auto rounded-lg border border-border bg-input p-3 text-xs">{preview.xml}</pre>
      <p className="text-xs text-muted">{preview.revision === null ? "Creates a new file in the series folder shown above." : "Updates this NFO and keeps a uniquely named backup beside it."}</p>
      <button className={`${button} border-accent bg-accent text-black`} disabled={pending} onClick={() => save.mutate()}>{save.isPending ? "Saving…" : "Save beside series"}</button>
    </div>}
    {saved && <p role="status" className="mt-4 text-sm text-green-300">Saved beside the series. PosterView will read this metadata next time you open this folder.</p>}
  </section>;
}
