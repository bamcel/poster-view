import ImportServerLibrary from "./ImportServerLibrary";
import LibraryPosterStrip from "./LibraryPosterStrip";
import ConnectedServerSync, {SyncActions} from "./ConnectedServerSync";
import NativeScanProgress from "./NativeScanProgress";
import { useEffect, useRef, useState } from "react";
import LibrarySettings from "./NativeLibrarySettings";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, ChevronRight, Folder, FolderPlus, Loader2, MoreHorizontal, RefreshCw, Trash2, Plus, Search, X } from "lucide-react";
import { defaultNativeOptions, nativeLibraries, type NativeLibrary, type NativeLibraryInput, type NativeLibraryType } from "../api/nativeLibraries";

const TYPES: Record<NativeLibraryType, string> = { movies: "Movies", shows: "TV Shows", anime: "Anime", books: "Books" };
const INPUT = "w-full rounded border border-border bg-input px-3 py-2.5 text-sm text-white focus:border-accent focus:outline-none";
const BUTTON = "rounded-xl border border-edge px-3 py-2 text-sm text-muted hover:bg-base hover:text-white disabled:opacity-50";
const MENU_ACTION = "w-full rounded-md px-3 py-3 text-left text-sm font-medium text-muted transition-colors hover:bg-white/10 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50";
const STEPS = ["General", "Folders", "Library Settings", "Metadata", "Artwork", "Advanced", "Review"];
const displayPath = (path: string) => `/media${path ? `/${path}` : ""}`;

function overlap(paths: string[]): boolean {
  return paths.some((p, i) => paths.slice(0, i).some(other => !p || !other || p === other || p.startsWith(`${other}/`) || other.startsWith(`${p}/`)));
}

export default function NativeLibrariesSection() {
  const libraries = useQuery({ queryKey: ["native-libraries"], queryFn: nativeLibraries.list });
  const [importing,setImporting]=useState(false);
  const [editing, setEditing] = useState<NativeLibrary | "new" | null>(null);
  const client = useQueryClient();
  const scanAll = useMutation({mutationFn: async () => {
    const results = await Promise.allSettled((libraries.data ?? []).map(library => nativeLibraries.scan(library.id)));
    await client.invalidateQueries({queryKey: ["native-scan"]});
    await client.invalidateQueries({queryKey: ["native-previews"]});
    const failures = results.filter(result => result.status === "rejected");
    if (failures.length) throw new Error(`${failures.length} libraries could not start scanning. Check their scan notices and retry.`);
  }});
  const trigger = useRef<HTMLButtonElement | null>(null);
  const close = () => { setEditing(null); trigger.current?.focus(); };
  return <section className="h-full overflow-y-auto py-3">
    <div className="relative mb-8 flex flex-wrap items-center justify-center gap-3">
      <span className="text-sm text-muted">{libraries.data?.length ?? 0} Libraries</span>
      <button className="inline-flex items-center gap-2 rounded-full bg-elevated px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent hover:text-base" onClick={event => { trigger.current = event.currentTarget; setEditing("new"); }}><Plus className="size-4" />New Library</button>
      <button className="inline-flex items-center gap-2 rounded-full bg-elevated px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent hover:text-base disabled:opacity-50" disabled={!libraries.data?.length || scanAll.isPending} onClick={() => scanAll.mutate()}><RefreshCw className={`size-4 ${scanAll.isPending ? "animate-spin" : ""}`} />Scan Libraries</button>
      <button className="inline-flex items-center gap-2 rounded-full bg-elevated px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent hover:text-base" onClick={()=>setImporting(true)}><FolderPlus className="size-4" />Import library</button>
    </div>
    {scanAll.error && <p role="alert" className="mb-4 text-sm text-danger">{scanAll.error.message}</p>}
    {libraries.isPending && <p role="status" className="text-muted">Loading libraries…</p>}
    {libraries.error && <div role="alert" className="text-danger">{libraries.error.message} <button className={BUTTON} onClick={() => void libraries.refetch()}>Retry</button></div>}
    {libraries.data?.length === 0 && <div className="rounded-2xl border border-dashed border-edge p-10 text-center text-muted"><FolderPlus className="mx-auto mb-3 size-8 text-accent" /><p>No libraries yet.</p><p className="mt-1 text-sm">Choose a type and select folders inside /media to get started.</p></div>}
    <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">{libraries.data?.map(library => <LibraryCard key={library.id} library={library} onEdit={button=>{trigger.current=button;setEditing(library);}} />)}</div>
    {importing&&<ImportServerLibrary onClose={()=>setImporting(false)} onSaved={()=>{setImporting(false);void client.invalidateQueries({queryKey:["native-libraries"]});}}/>}
    {editing && <LibraryDialog library={editing === "new" ? undefined : editing} onClose={close} onSaved={() => { void client.invalidateQueries({ queryKey: ["native-libraries"] }); close(); }} />}
  </section>;
}

function LibraryCard({library,onEdit}:{library:NativeLibrary;onEdit:(button:HTMLButtonElement)=>void}) {
  const client = useQueryClient();
  const [confirmDelete,setConfirmDelete]=useState(false),[open,setOpen]=useState(false),[notices,setNotices]=useState(false);
  const previews=useQuery({queryKey:["native-previews",library.id],queryFn:()=>nativeLibraries.previews(library.id),enabled:open,staleTime:60_000});
  const menu=useRef<HTMLDivElement>(null), action=useRef<HTMLButtonElement>(null);
  const [position,setPosition]=useState({top:0,left:0});
  useEffect(()=>{if(!open)return;
    const place=()=>{const rect=action.current?.getBoundingClientRect();if(!rect)return;const width=Math.min(352,window.innerWidth-24);setPosition({left:Math.max(12,Math.min(rect.right-width,window.innerWidth-width-12)),top:Math.max(12,Math.min(rect.bottom+8,window.innerHeight-200))});};place();
    const close=(event:PointerEvent)=>{if(!menu.current?.contains(event.target as Node)&&!action.current?.contains(event.target as Node))setOpen(false);};
    const key=(event:KeyboardEvent)=>{if(event.key==="Escape"){setOpen(false);action.current?.focus();}};
    document.addEventListener("pointerdown",close);document.addEventListener("keydown",key);window.addEventListener("resize",place);window.addEventListener("scroll",place,true);
    return()=>{document.removeEventListener("pointerdown",close);document.removeEventListener("keydown",key);window.removeEventListener("resize",place);window.removeEventListener("scroll",place,true);};
  },[open]);
  const status = useQuery({queryKey:["native-scan",library.id],queryFn:()=>nativeLibraries.status(library.id),refetchInterval:query=>query.state.data?.status==="scanning"?2000:false});
  const syncStatus=useQuery({queryKey:["native-sync",library.id],queryFn:()=>nativeLibraries.syncStatus(library.id),enabled:!!library.options?.server_sync?.enabled,refetchInterval:5000});
  const scan=useMutation({mutationFn:()=>nativeLibraries.scan(library.id),onSuccess:()=>{void client.invalidateQueries({queryKey:["native-scan",library.id]});void client.invalidateQueries({queryKey:["native-previews",library.id]});}});
  const remove=useMutation({mutationFn:()=>nativeLibraries.remove(library.id,library.revision),onSuccess:()=>{void client.invalidateQueries({queryKey:["native-libraries"]});}});
  const busy=status.data?.status==="scanning"||scan.isPending||remove.isPending;
  return <article className="group relative overflow-hidden rounded-xl bg-window">
    <div className="relative overflow-hidden rounded-xl"><LibraryPosterStrip library={library.id}/><button ref={action} aria-label={`Actions for ${library.name}`} aria-expanded={open} onClick={()=>setOpen(!open)} className={`absolute bottom-2 right-2 grid size-8 place-items-center rounded-full border border-white/15 bg-black/40 text-white backdrop-blur transition-opacity hover:bg-black/60 [@media(hover:hover)]:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 ${open ? "!opacity-100" : ""}`}><MoreHorizontal className="size-4"/></button></div>
    <div className="flex h-40 flex-col bg-window px-4 pb-4 pt-2">
      <div className="text-center"><h3 className="truncate font-semibold text-white" title={library.name}>{library.name}</h3><p className="truncate text-xs text-muted" title={library.paths.map(displayPath).join("\n")}>{library.paths.length===1?displayPath(library.paths[0]):`${library.paths.length} folders`}</p></div>
      <div className="mt-3 min-h-0 overflow-y-auto text-xs text-muted">{status.data?.status === "scanning" && <NativeScanProgress status={status.data} compact/>}{scan.isPending && status.data?.status !== "scanning" && <p role="status">Starting scan…</p>}{syncStatus.data?.status === "syncing" && <p role="status" className="mt-2">Syncing · {syncStatus.data.pending} pending</p>}</div>
    </div>
    {open&&createPortal(<div ref={menu} role="region" aria-label={`Library actions for ${library.name}`} style={{...position,backgroundColor:"var(--color-surface, #20232b)",maxHeight:`calc(100dvh - ${position.top+12}px)`}} className="fixed z-[90] w-[min(22rem,calc(100vw-24px))] overflow-y-auto rounded-2xl p-4 text-white shadow-2xl">
        <div className="mb-3 flex items-center gap-3"><div aria-hidden="true" className="flex w-20 shrink-0 overflow-hidden rounded">{previews.data?.slice(0,4).map(item=><img key={item.id} src={nativeLibraries.artworkUrl(library.id,item.id,"poster")+`?v=${item.revision}`} alt="" className="aspect-[2/3] w-1/4 object-cover"/>)}</div><p className="font-semibold">{library.name}</p></div>
        <div className="flex flex-col"><button className={`${MENU_ACTION} flex items-center justify-between`} onClick={()=>{setOpen(false);if(action.current)onEdit(action.current);}}>Library<Folder className="size-4"/></button><button className={`${MENU_ACTION} flex items-center justify-between`} disabled={busy} onClick={()=>scan.mutate()}>Scan Library Files<RefreshCw className="size-4"/></button>
        {library.options?.server_sync?.enabled&&<SyncActions library={library.id} menu/>}
        <button className={MENU_ACTION} onClick={()=>setNotices(!notices)}>View notices / activity</button>
        {notices&&<div className="space-y-2 text-xs text-muted">{[...(status.data?.warnings??[]),...(syncStatus.data?.notices??[]),...(syncStatus.data?.activity??[])].map((message,i)=><p key={i}>{message}</p>)}{!status.data?.warnings.length&&!syncStatus.data?.notices.length&&!syncStatus.data?.activity.length&&<p>No notices or activity.</p>}</div>}
        <div className="border-t border-edge pt-2"><button className={`${MENU_ACTION} flex w-full items-center justify-between text-danger`} disabled={busy} onClick={()=>setConfirmDelete(true)}>Remove<Trash2 className="size-4"/></button></div></div>
        {confirmDelete&&<div role="alertdialog" aria-label="Remove library confirmation" className="mt-3 rounded-xl border border-edge bg-base p-3"><p className="text-sm text-muted">Remove {library.name}? Media, NFO files, and local artwork will be kept.</p><div className="mt-3 flex gap-2"><button className={BUTTON} disabled={busy} onClick={()=>setConfirmDelete(false)}>Cancel</button><button className={`${BUTTON} text-danger`} disabled={busy} onClick={()=>remove.mutate()}>Confirm removal</button></div></div>}
    </div>,document.body)}
    {(scan.error||remove.error||status.error)&&<p role="alert" className="px-4 text-sm text-danger">{(scan.error||remove.error||status.error)?.message}</p>}
  </article>;
}

export function LibraryDialog({ library, seed, onClose, onSaved }: { library?: NativeLibrary; seed?: NativeLibraryInput; onClose: () => void; onSaved: () => void }) {
  const initial = useRef<NativeLibraryInput>(seed ?? (library ? { name: library.name, library_type: library.library_type, anime_content: library.anime_content, paths: library.paths, options: { ...defaultNativeOptions, ...library.options }, revision: library.revision } : { name: "", library_type: "movies", anime_content: "both", paths: [], options: { ...defaultNativeOptions }, revision: null }));
  const [draft, setDraft] = useState(initial.current);
  const [step, setStep] = useState(0);
  const [path, setPath] = useState("");
  const [filter, setFilter] = useState("");
  const [discard, setDiscard] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLElement>(null);
  useEffect(() => { if (content.current) content.current.scrollTop = 0; }, [step]);
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
    <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="library-dialog-title" className="flex h-full w-full max-w-5xl flex-col overflow-hidden border border-border bg-sidebar shadow-2xl sm:h-[min(760px,90dvh)] sm:rounded-2xl">
      <header className="flex shrink-0 items-center gap-4 bg-sidebar px-6 py-4 sm:px-8"><div><h2 id="library-dialog-title" className="text-lg font-semibold text-white">{library ? "Edit library" : "Create library"}</h2><p className="mt-1 text-xs text-muted">PosterView library</p></div><button aria-label="Close library dialog" disabled={save.isPending} className="ml-auto shrink-0 grid size-9 place-items-center rounded-lg text-muted hover:bg-elevated hover:text-white disabled:opacity-50" onClick={() => closeRef.current()}><X className="size-5" /></button></header>
      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <nav aria-label="Library setup sections" className="flex shrink-0 gap-2 overflow-x-auto bg-window border-b border-border p-3 sm:w-44 sm:shrink-0 sm:flex-col sm:border-b-0 sm:border-r">{STEPS.map((label, index) => <button key={label} aria-current={step === index ? "step" : undefined} disabled={save.isPending} onClick={() => setStep(index)} className={`flex shrink-0 items-center gap-2 rounded-xl px-3 py-2.5 text-sm ${step === index ? "bg-accent/15 text-accent" : "text-muted hover:bg-window"}`}><span className="text-xs opacity-60">{index + 1}</span>{label}</button>)}</nav>
        <main ref={content} className="min-h-0 flex-1 overflow-y-auto bg-sidebar p-6 sm:p-8">
          {discard && <div className="mb-5 rounded-xl border border-border bg-window p-4" role="alert"><p className="text-sm text-white">Discard your unsaved changes?</p><div className="mt-3 flex gap-2"><button className={BUTTON} onClick={() => setDiscard(false)}>Keep editing</button><button className={`${BUTTON} text-danger`} onClick={onClose}>Discard changes</button></div></div>}
          {step === 0 && <div className="space-y-6"><div><h3 className="font-medium text-white">General</h3><p className="mt-1 text-sm text-muted">Choose how this collection is organized.</p></div>
            <label className="block text-sm text-muted">Name<input autoComplete="off" maxLength={120} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} className={`${INPUT} mt-2`} placeholder="e.g. Anime, Movies, Manga" /></label>
            <label className="block text-sm text-muted">Library type<select className={`${INPUT} mt-2`} value={draft.library_type} onChange={e => setDraft({ ...draft, library_type: e.target.value as NativeLibraryType, options: {...defaultNativeOptions, ...draft.options, metadata_providers: {}, image_providers: {}} })}>{Object.entries(TYPES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            {draft.library_type === "anime" && <label className="block text-sm text-muted">Anime content<select aria-label="Anime content" aria-describedby="anime-content-help" className={`${INPUT} mt-2`} value={draft.anime_content} onChange={e => setDraft({ ...draft, anime_content: e.target.value as NativeLibraryInput["anime_content"] })}><option value="both">Mixed</option><option value="shows">Shows only</option><option value="movies">Movies only</option></select><span id="anime-content-help" className="mt-2 block text-xs text-faint">Anime is a dedicated library type. Each title will retain its movie or series identity.</span></label>}
            {draft.library_type === "books" && <p className="rounded-xl bg-window p-4 text-sm text-muted">Your existing book reader and custom NFO metadata tools remain available. Native scanning preserves custom book NFO fields and identifies supported book files.</p>}
          </div>}
          {step === 1 && <div className="space-y-4"><div><h3 className="font-medium text-white">Media folders</h3><p className="mt-1 text-sm text-muted">Check folders to select them; use the arrow to browse inside. Selections stay selected as you browse.</p></div>
            <div className="flex flex-wrap items-center gap-1 text-sm text-muted"><button className={BUTTON} onClick={() => navigate("")}>/media</button>{path.split("/").filter(Boolean).map((part, i, parts) => <span className="flex items-center" key={parts.slice(0, i + 1).join("/")}><ChevronRight className="size-4" /><button className="rounded px-2 py-1 hover:text-accent" onClick={() => navigate(parts.slice(0, i + 1).join("/"))}>{part}</button></span>)}</div>
            <div className="flex flex-wrap gap-2">{path && <button className={BUTTON} onClick={() => navigate(path.split("/").slice(0, -1).join("/"))}><ArrowLeft className="size-4" aria-label="Parent folder" /></button>}<button disabled={!folders.data || folders.isFetching || !!folders.error} className={BUTTON} onClick={() => toggle(path)}>{draft.paths.includes(path) ? "Deselect current folder" : "Select current folder"}</button><button disabled={!visible.length} className={BUTTON} onClick={() => setDraft(previous => ({ ...previous, paths: [...new Set([...previous.paths, ...visible.map(f => f.path)])] }))}>Select all visible</button></div>
            <label className="flex items-center gap-2 rounded-xl border border-border bg-window px-3"><Search className="size-4 text-faint" /><input aria-label="Filter folders" value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter folders" className="w-full bg-transparent py-2.5 text-sm text-white outline-none" /></label>
            {folders.isPending && <p role="status" className="text-sm text-muted">Loading folders…</p>}
            {folders.error && <div role="alert" className="text-sm text-danger">{folders.error.message}<button className={`${BUTTON} ml-2`} onClick={() => void folders.refetch()}>Retry</button></div>}
            {!folders.isPending && !folders.error && visible.length === 0 && <p className="py-4 text-sm text-muted">{filter ? "No matching folders." : "No subfolders. You can select the current folder."}</p>}
            <div className="max-h-64 overflow-y-auto rounded-xl border border-border">{visible.map(folder => <div key={folder.path} className={`flex items-center gap-3 border-b border-border last:border-b-0 ${draft.paths.includes(folder.path) ? "bg-accent/10" : ""}`}><label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 p-3 text-sm text-white"><input className="size-4 accent-accent" type="checkbox" checked={draft.paths.includes(folder.path)} onChange={() => toggle(folder.path)} /><Folder className="size-4 shrink-0 text-accent" /><span className="truncate">{folder.name}</span></label><button aria-label={`Open ${folder.name}`} className="m-1 rounded-lg p-3 text-muted hover:bg-window" onClick={() => navigate(folder.path)}><ChevronRight className="size-4" /></button></div>)}</div>
            <div className="rounded-xl bg-window p-4"><p className="mb-2 text-sm font-medium text-white">{draft.paths.length} folders selected</p><ul className="space-y-1">{draft.paths.map(selected => <li key={selected} className="flex items-center justify-between gap-2 text-xs text-muted"><span className="break-all">{displayPath(selected)}</span><button className="shrink-0 rounded-lg p-2 hover:text-danger" aria-label={`Remove ${displayPath(selected)}`} onClick={() => toggle(selected)}><X className="size-4" /></button></li>)}</ul></div>
            {overlap(draft.paths) && <p role="alert" className="text-sm text-danger">Selected folders overlap. Select a parent folder or its children, rather than both.</p>}
            {draft.paths.length > 32 && <p role="alert" className="text-sm text-danger">Choose at most 32 folders.</p>}
          </div>}
          {[2, 3, 4, 5].includes(step) && <LibrarySettings options={{...defaultNativeOptions, ...draft.options}} type={draft.library_type} animeContent={draft.anime_content} section={step} onChange={options => setDraft(previous => ({...previous, options}))} />}
          {step === 5 && <ConnectedServerSync value={draft.options?.server_sync} library={library?.id} onChange={server_sync=>setDraft(previous=>({...previous,options:{...defaultNativeOptions,...previous.options,server_sync}}))}/>}
          {step === 6 && <div className="space-y-5"><div><h3 className="font-medium text-white">Review your library</h3><p className="mt-1 text-sm text-muted">Folders are validated before the configuration is saved.</p></div><dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-3 text-sm"><dt className="text-faint">Name</dt><dd className="break-all text-white">{draft.name || "Not set"}</dd><dt className="text-faint">Type</dt><dd className="text-white">{TYPES[draft.library_type]}</dd>{draft.library_type === "anime" && <><dt className="text-faint">Content</dt><dd className="text-white">{draft.anime_content === "both" ? "Mixed" : draft.anime_content === "shows" ? "Shows only" : "Movies only"}</dd></>}</dl><div className="rounded-xl border border-border p-4"><h4 className="mb-2 text-sm text-white">Media roots</h4>{draft.paths.map(p => <p key={p} className="break-all text-sm text-muted">{displayPath(p)}</p>)}</div><p className="text-sm text-muted">New libraries scan after saving. Local files are written only when Save metadata to NFO is enabled. Existing libraries can be scanned from their library card.</p>{(basicsInvalid || pathsInvalid) && <p role="alert" className="text-sm text-danger">Enter a name and select 1–32 folders without overlaps before saving.</p>}</div>}
          {save.error && <p role="alert" className="mt-5 text-sm text-danger">{save.error.message}</p>}
        </main>
      </div>
      <footer className="flex shrink-0 items-center justify-between gap-3 bg-sidebar px-6 py-5 sm:px-8"><button className={BUTTON} disabled={save.isPending} onClick={() => step ? setStep(step - 1) : closeRef.current()}>{step ? "Back" : "Cancel"}</button>{step < STEPS.length - 1 ? <button className="rounded-xl bg-accent px-5 py-2.5 text-sm font-medium text-base disabled:opacity-50" disabled={save.isPending || (step === 0 ? basicsInvalid : pathsInvalid)} onClick={() => setStep(step + 1)}>Next</button> : <button className="inline-flex items-center gap-2 rounded-xl bg-accent px-5 py-2.5 text-sm font-medium text-base disabled:opacity-50" disabled={basicsInvalid || pathsInvalid || save.isPending} onClick={() => save.mutate()}>{save.isPending ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}{save.isPending ? "Saving…" : library ? "Save library" : "Create library"}</button>}</footer>
    </div>
  </div>, document.body);
}
