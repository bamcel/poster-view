import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, ChevronRight, Folder, FolderPlus, Loader2, Pencil, Plus, Search, X } from "lucide-react";
import { defaultNativeOptions, nativeLibraries, type NativeLibrary, type NativeLibraryInput, type NativeLibraryType } from "../api/nativeLibraries";

const TYPES: Record<NativeLibraryType, string> = { movies: "Movies", shows: "TV Shows", anime: "Anime", books: "Books" };
const INPUT = "w-full rounded-xl border border-edge bg-base px-3 py-2.5 text-sm text-white focus:border-accent focus:outline-none";
const BUTTON = "rounded-xl border border-edge px-3 py-2 text-sm text-muted hover:bg-base hover:text-white disabled:opacity-50";
const STEPS = ["General", "Folders", "Metadata", "Review"];
const displayPath = (path: string) => `/media${path ? `/${path}` : ""}`;

function overlap(paths: string[]): boolean {
  return paths.some((p, i) => paths.slice(0, i).some(other => !p || !other || p === other || p.startsWith(`${other}/`) || other.startsWith(`${p}/`)));
}

export default function NativeLibrariesSection() {
  const libraries = useQuery({ queryKey: ["native-libraries"], queryFn: nativeLibraries.list });
  const [editing, setEditing] = useState<NativeLibrary | "new" | null>(null);
  const client = useQueryClient();
  const trigger = useRef<HTMLButtonElement | null>(null);
  const close = () => { setEditing(null); trigger.current?.focus(); };
  return <section className="h-full overflow-y-auto py-3">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div><h2 className="text-lg font-semibold text-white">Native libraries</h2>
        <p className="mt-1 max-w-xl text-sm text-muted">Organize your mounted media independently of connected servers.</p></div>
      <button className="inline-flex items-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-base" onClick={event => { trigger.current = event.currentTarget; setEditing("new"); }}><Plus className="size-4" />Add library</button>
    </div>
    <p className="my-5 rounded-xl border border-edge bg-panel p-4 text-sm text-muted">New libraries scan after creation. Local metadata and artwork take priority; missing information can be fetched from providers. Scan files or delete a library directly from its card.</p>
    {libraries.isPending && <p role="status" className="text-muted">Loading libraries…</p>}
    {libraries.error && <div role="alert" className="text-danger">{libraries.error.message} <button className={BUTTON} onClick={() => void libraries.refetch()}>Retry</button></div>}
    {libraries.data?.length === 0 && <div className="rounded-2xl border border-dashed border-edge p-10 text-center text-muted"><FolderPlus className="mx-auto mb-3 size-8 text-accent" /><p>No native libraries yet.</p><p className="mt-1 text-sm">Choose a type and select folders inside /media to get started.</p></div>}
    <div className="grid gap-3 lg:grid-cols-2">{libraries.data?.map(library => <article key={library.id} className="rounded-2xl border border-edge bg-panel p-4">
      <div className="flex items-start justify-between gap-3"><div><h3 className="font-medium text-white">{library.name}</h3><p className="mt-1 text-xs text-accent">{TYPES[library.library_type]}{library.library_type === "anime" ? ` · ${library.anime_content === "both" ? "Shows and movies" : library.anime_content === "shows" ? "Shows only" : "Movies only"}` : ""}</p></div>
        <button aria-label={`Edit ${library.name}`} className={BUTTON} onClick={event => { trigger.current = event.currentTarget; setEditing(library); }}><Pencil className="size-4" /></button></div>
      <ul className="mt-4 space-y-1 text-xs text-muted">{library.paths.map(path => <li className="break-all" key={path}>{displayPath(path)}</li>)}</ul>
      <LibraryActions library={library} />
    </article>)}</div>
    {editing && <LibraryDialog library={editing === "new" ? undefined : editing} onClose={close} onSaved={() => { void client.invalidateQueries({ queryKey: ["native-libraries"] }); close(); }} />}
  </section>;
}

function LibraryActions({ library }: { library: NativeLibrary }) {
  const client = useQueryClient();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const status = useQuery({ queryKey: ["native-scan", library.id], queryFn: () => nativeLibraries.status(library.id), refetchInterval: query => query.state.data?.status === "scanning" ? 2000 : false });
  const scan = useMutation({ mutationFn: () => nativeLibraries.scan(library.id), onSuccess: () => { void client.invalidateQueries({queryKey: ["native-scan", library.id]}); } });
  const remove = useMutation({ mutationFn: () => nativeLibraries.remove(library.id, library.revision), onSuccess: () => { void client.invalidateQueries({queryKey: ["native-libraries"]}); } });
  const busy = status.data?.status === "scanning" || scan.isPending || remove.isPending;
  return <div className="mt-4 space-y-3">
    {status.data && <p role="status" className="text-xs text-muted">{status.data.status === "scanning" ? "Scanning files…" : status.data.status.replaceAll("_", " ")} · {status.data.count} items</p>}
    <div className="flex flex-wrap gap-2"><button className={BUTTON} disabled={busy} onClick={() => scan.mutate()}>Scan files</button><button className={`${BUTTON} text-danger`} disabled={busy} onClick={() => setConfirmDelete(true)}>Delete library</button></div>
    {confirmDelete && <div className="rounded-xl border border-edge bg-base p-3"><p className="text-sm text-muted">Delete {library.name}? Media and NFO files will be kept.</p><div className="mt-3 flex flex-wrap gap-2"><button className={BUTTON} disabled={busy} onClick={() => setConfirmDelete(false)}>Cancel</button><button className={`${BUTTON} text-danger`} disabled={busy} onClick={() => remove.mutate()}>Confirm deletion</button></div></div>}
    {(scan.error || remove.error || status.error) && <p role="alert" className="text-sm text-danger">{(scan.error || remove.error || status.error)?.message}</p>}
    {!!status.data?.warnings.length && <details className="text-xs text-muted"><summary className="cursor-pointer">{status.data.warnings.length} scan notices</summary><ul className="mt-2 space-y-1">{status.data.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul></details>}
  </div>;
}

export function LibraryDialog({ library, onClose, onSaved }: { library?: NativeLibrary; onClose: () => void; onSaved: () => void }) {
  const initial = useRef<NativeLibraryInput>(library ? { name: library.name, library_type: library.library_type, anime_content: library.anime_content, paths: library.paths, options: { ...defaultNativeOptions, ...library.options }, revision: library.revision } : { name: "", library_type: "movies", anime_content: "both", paths: [], options: { ...defaultNativeOptions }, revision: null });
  const [draft, setDraft] = useState(initial.current);
  const [step, setStep] = useState(0);
  const [path, setPath] = useState("");
  const [filter, setFilter] = useState("");
  const [discard, setDiscard] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const save = useMutation({ mutationFn: () => nativeLibraries.save(draft, library?.id), onSuccess: onSaved });
  const folders = useQuery({ queryKey: ["native-folders", path], queryFn: () => nativeLibraries.folders(path), enabled: step === 1 });
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial.current);
  const closeRef = useRef<() => void>(() => {});
  closeRef.current = () => { if (save.isPending) return; if (dirty) setDiscard(true); else onClose(); };
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.current?.querySelector<HTMLElement>("input,button")?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); closeRef.current(); }
      if (event.key !== "Tab") return;
      const focusable = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex="0"]') ?? [])];
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", keydown);
    return () => { document.body.style.overflow = previousOverflow; document.removeEventListener("keydown", keydown); };
  }, []);
  const toggle = (selected: string) => setDraft(previous => ({ ...previous, paths: previous.paths.includes(selected) ? previous.paths.filter(p => p !== selected) : [...previous.paths, selected] }));
  const pathsInvalid = draft.paths.length === 0 || draft.paths.length > 32 || overlap(draft.paths);
  const basicsInvalid = !draft.name.trim() || draft.name.trim().length > 120;
  const navigate = (next: string) => { setPath(next); setFilter(""); };
  const visible = folders.data?.folders.filter(folder => folder.name.toLowerCase().includes(filter.toLowerCase())) ?? [];
  return createPortal(<div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 backdrop-blur-sm sm:p-6">
    <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="library-dialog-title" className="flex h-full w-full max-w-5xl flex-col overflow-hidden border border-edge bg-panel shadow-2xl sm:h-[min(760px,90dvh)] sm:rounded-2xl">
      <header className="flex items-center justify-between border-b border-edge px-5 py-4"><div><h2 id="library-dialog-title" className="text-lg font-semibold text-white">{library ? "Edit library" : "Create library"}</h2><p className="mt-1 text-xs text-muted">Native media · No server import</p></div><button aria-label="Close library dialog" disabled={save.isPending} className={BUTTON} onClick={() => closeRef.current()}><X className="size-5" /></button></header>
      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <nav aria-label="Library setup sections" className="flex shrink-0 gap-2 overflow-x-auto border-b border-edge p-3 sm:w-44 sm:shrink-0 sm:flex-col sm:border-b-0 sm:border-r">{STEPS.map((label, index) => <button key={label} aria-current={step === index ? "step" : undefined} disabled={save.isPending} onClick={() => setStep(index)} className={`flex shrink-0 items-center gap-2 rounded-xl px-3 py-2.5 text-sm ${step === index ? "bg-accent/15 text-accent" : "text-muted hover:bg-base"}`}><span className="text-xs opacity-60">{index + 1}</span>{label}</button>)}</nav>
        <main className="min-h-0 flex-1 overflow-y-auto p-5 sm:p-7">
          {discard && <div className="mb-5 rounded-xl border border-edge bg-base p-4" role="alert"><p className="text-sm text-white">Discard your unsaved changes?</p><div className="mt-3 flex gap-2"><button className={BUTTON} onClick={() => setDiscard(false)}>Keep editing</button><button className={`${BUTTON} text-danger`} onClick={onClose}>Discard changes</button></div></div>}
          {step === 0 && <div className="space-y-6"><div><h3 className="font-medium text-white">General</h3><p className="mt-1 text-sm text-muted">Choose how this collection is organized.</p></div>
            <label className="block text-sm text-muted">Name<input autoComplete="off" maxLength={120} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} className={`${INPUT} mt-2`} placeholder="e.g. Anime, Movies, Manga" /></label>
            <label className="block text-sm text-muted">Library type<select className={`${INPUT} mt-2`} value={draft.library_type} onChange={e => setDraft({ ...draft, library_type: e.target.value as NativeLibraryType })}>{Object.entries(TYPES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            {draft.library_type === "anime" && <label className="block text-sm text-muted">Anime content<select aria-label="Anime content" aria-describedby="anime-content-help" className={`${INPUT} mt-2`} value={draft.anime_content} onChange={e => setDraft({ ...draft, anime_content: e.target.value as NativeLibraryInput["anime_content"] })}><option value="both">Shows and movies</option><option value="shows">Shows only</option><option value="movies">Movies only</option></select><span id="anime-content-help" className="mt-2 block text-xs text-faint">Anime is a dedicated library type. Each title will retain its movie or series identity.</span></label>}
            {draft.library_type === "books" && <p className="rounded-xl bg-base p-4 text-sm text-muted">Your existing book reader and custom NFO metadata tools remain available. Native catalog integration will be added separately.</p>}
          </div>}
          {step === 1 && <div className="space-y-4"><div><h3 className="font-medium text-white">Media folders</h3><p className="mt-1 text-sm text-muted">Check folders to select them; use the arrow to browse inside. Selections stay selected as you browse.</p></div>
            <div className="flex flex-wrap items-center gap-1 text-sm text-muted"><button className={BUTTON} onClick={() => navigate("")}>/media</button>{path.split("/").filter(Boolean).map((part, i, parts) => <span className="flex items-center" key={parts.slice(0, i + 1).join("/")}><ChevronRight className="size-4" /><button className="rounded px-2 py-1 hover:text-accent" onClick={() => navigate(parts.slice(0, i + 1).join("/"))}>{part}</button></span>)}</div>
            <div className="flex flex-wrap gap-2">{path && <button className={BUTTON} onClick={() => navigate(path.split("/").slice(0, -1).join("/"))}><ArrowLeft className="size-4" aria-label="Parent folder" /></button>}<button disabled={!folders.data || folders.isFetching || !!folders.error} className={BUTTON} onClick={() => toggle(path)}>{draft.paths.includes(path) ? "Deselect current folder" : "Select current folder"}</button><button disabled={!visible.length} className={BUTTON} onClick={() => setDraft(previous => ({ ...previous, paths: [...new Set([...previous.paths, ...visible.map(f => f.path)])] }))}>Select all visible</button></div>
            <label className="flex items-center gap-2 rounded-xl border border-edge bg-base px-3"><Search className="size-4 text-faint" /><input aria-label="Filter folders" value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter folders" className="w-full bg-transparent py-2.5 text-sm text-white outline-none" /></label>
            {folders.isPending && <p role="status" className="text-sm text-muted">Loading folders…</p>}
            {folders.error && <div role="alert" className="text-sm text-danger">{folders.error.message}<button className={`${BUTTON} ml-2`} onClick={() => void folders.refetch()}>Retry</button></div>}
            {!folders.isPending && !folders.error && visible.length === 0 && <p className="py-4 text-sm text-muted">{filter ? "No matching folders." : "No subfolders. You can select the current folder."}</p>}
            <div className="max-h-64 overflow-y-auto rounded-xl border border-edge">{visible.map(folder => <div key={folder.path} className={`flex items-center gap-3 border-b border-edge last:border-b-0 ${draft.paths.includes(folder.path) ? "bg-accent/10" : ""}`}><label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 p-3 text-sm text-white"><input className="size-4 accent-accent" type="checkbox" checked={draft.paths.includes(folder.path)} onChange={() => toggle(folder.path)} /><Folder className="size-4 shrink-0 text-accent" /><span className="truncate">{folder.name}</span></label><button aria-label={`Open ${folder.name}`} className="m-1 rounded-lg p-3 text-muted hover:bg-base" onClick={() => navigate(folder.path)}><ChevronRight className="size-4" /></button></div>)}</div>
            <div className="rounded-xl bg-base p-4"><p className="mb-2 text-sm font-medium text-white">{draft.paths.length} folders selected</p><ul className="space-y-1">{draft.paths.map(selected => <li key={selected} className="flex items-center justify-between gap-2 text-xs text-muted"><span className="break-all">{displayPath(selected)}</span><button className="shrink-0 rounded-lg p-2 hover:text-danger" aria-label={`Remove ${displayPath(selected)}`} onClick={() => toggle(selected)}><X className="size-4" /></button></li>)}</ul></div>
            {overlap(draft.paths) && <p role="alert" className="text-sm text-danger">Selected folders overlap. Select a parent folder or its children, rather than both.</p>}
            {draft.paths.length > 32 && <p role="alert" className="text-sm text-danger">Choose at most 32 folders.</p>}
          </div>}
          {step === 2 && <div className="space-y-6"><div><h3 className="font-medium text-white">Metadata and artwork</h3><p className="mt-1 text-sm text-muted">The database always stores your library metadata and artwork records. Local files take priority; manual edits remain locked during rescans.</p></div>
            {([
              ["read_nfo", "Read local NFO metadata", "Use existing NFO files before fetching metadata. Books keep their custom series NFO format."],
              ["save_nfo", "Save metadata to NFO", "Write metadata beside your media. Requires write permission. Existing unknown XML fields are preserved; invalid NFO files are never replaced."],
              ["local_artwork", "Use local artwork", "Discover supported posters, backdrops, banners, logos, and thumbnails beside your media."],
              ["fetch_missing", "Fetch missing metadata and artwork", "Use AniList for Anime and Books, and TMDB for movies, shows, and episode details. TMDB uses the credential in Search Providers. Uncertain matches need review."],
            ] as const).map(([key, label, help]) => <label key={key} className="flex items-start gap-3 rounded-xl border border-edge bg-base p-4"><input type="checkbox" className="mt-1 size-4 accent-accent" aria-label={label} checked={draft.options?.[key] ?? defaultNativeOptions[key]} onChange={e => setDraft(previous => ({...previous, options: {...defaultNativeOptions, ...previous.options, [key]: e.target.checked}}))} /><span><span className="text-sm font-medium text-white">{label}</span><span className="mt-1 block text-xs leading-relaxed text-muted">{help}</span></span></label>)}
          </div>}
          {step === 3 && <div className="space-y-5"><div><h3 className="font-medium text-white">Review your library</h3><p className="mt-1 text-sm text-muted">Folders are validated before the configuration is saved.</p></div><dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-3 text-sm"><dt className="text-faint">Name</dt><dd className="break-all text-white">{draft.name || "Not set"}</dd><dt className="text-faint">Type</dt><dd className="text-white">{TYPES[draft.library_type]}</dd>{draft.library_type === "anime" && <><dt className="text-faint">Content</dt><dd className="text-white">{draft.anime_content === "both" ? "Shows and movies" : draft.anime_content === "shows" ? "Shows only" : "Movies only"}</dd></>}</dl><div className="rounded-xl border border-edge p-4"><h4 className="mb-2 text-sm text-white">Media roots</h4>{draft.paths.map(p => <p key={p} className="break-all text-sm text-muted">{displayPath(p)}</p>)}</div><p className="text-sm text-muted">New libraries scan after saving. Local files are written only when Save metadata to NFO is enabled. Existing libraries can be scanned from their library card.</p>{(basicsInvalid || pathsInvalid) && <p role="alert" className="text-sm text-danger">Enter a name and select 1–32 folders without overlaps before saving.</p>}</div>}
          {save.error && <p role="alert" className="mt-5 text-sm text-danger">{save.error.message}</p>}
        </main>
      </div>
      <footer className="flex items-center justify-between gap-3 border-t border-edge px-5 py-4"><button className={BUTTON} disabled={save.isPending} onClick={() => step ? setStep(step - 1) : closeRef.current()}>{step ? "Back" : "Cancel"}</button>{step < 3 ? <button className="rounded-xl bg-accent px-5 py-2.5 text-sm font-medium text-base disabled:opacity-50" disabled={save.isPending || (step === 0 ? basicsInvalid : pathsInvalid)} onClick={() => setStep(step + 1)}>Next</button> : <button className="inline-flex items-center gap-2 rounded-xl bg-accent px-5 py-2.5 text-sm font-medium text-base disabled:opacity-50" disabled={basicsInvalid || pathsInvalid || save.isPending} onClick={() => save.mutate()}>{save.isPending ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}{save.isPending ? "Saving…" : library ? "Save library" : "Create library"}</button>}</footer>
    </div>
  </div>, document.body);
}
