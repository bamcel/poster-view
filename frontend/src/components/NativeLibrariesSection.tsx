import PopupPage from "./PopupPage";
import {useAutoSave} from "../lib/useAutoSave";
import {defaultWatchRules,validWatchRules} from "../features/playback/components/LibraryWatchRules";
import {watchApi,type WatchRules} from "../features/playback/api/watch";
import {sizedArtwork} from "../lib/artworkSizes";
import FolderBrowser from "./FolderBrowser";
import SeriesActionsDialog from "./SeriesActionsDialog";
import {youtubeOptions} from "../features/settings/ytdl/client";
import {BACKDROP_BLUR_EVENT, PANEL_SOLIDITY_EVENT, PANEL_OVERLAY_EVENT, backdropBlur, panelSolidity, panelOverlay, translucentPanelColor} from "../lib/dashboardSettings";
import LibraryPosterStrip from "./LibraryPosterStrip";
import NativeScanProgress from "./NativeScanProgress";
import { useEffect, useRef, useState } from "react";
import LibrarySettings from "./NativeLibrarySettings";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Folder, FolderPlus, Loader2, MoreHorizontal, RefreshCw, Trash2, Plus, X } from "lucide-react";
import { defaultNativeOptions, nativeLibraries, type NativeLibrary, type NativeLibraryInput, type NativeLibraryType } from "../api/nativeLibraries";

const TYPES: Record<NativeLibraryType, string> = { movies: "Movies", shows: "TV Shows", mixed: "Mixed (Movies & TV Shows)", anime: "Anime", books: "Books", youtube: "YouTube" };
const INPUT = "w-full rounded border border-border bg-input px-3 py-2.5 text-sm text-white focus:border-accent focus:outline-none";
const BUTTON = "rounded-xl border border-edge px-3 py-2 text-sm text-muted hover:bg-base hover:text-white disabled:opacity-50";
const MENU_ACTION = "w-full rounded-md px-3 py-3 text-left text-sm font-medium text-muted transition-colors hover:bg-white/10 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50";
const STEPS = ["General", "Folders", "Library Settings", "Metadata", "Artwork", "Advanced", "Review"];
const displayPath = (path: string) => `/media${path ? `/${path}` : ""}`;

function overlap(paths: string[]): boolean {
  return paths.some((p, i) => paths.slice(0, i).some(other => !p || !other || p === other || p.startsWith(`${other}/`) || other.startsWith(`${p}/`)));
}

export function NativeLibraryCount() {
  const libraries = useQuery({queryKey:["native-libraries"],queryFn:nativeLibraries.list});
  return <span className="shrink-0 text-xs text-muted">{libraries.data?.length ?? 0} Libraries</span>;
}

export default function NativeLibrariesSection() {
  const [, refreshAppearance] = useState(0);
  useEffect(() => {
    const refresh = () => refreshAppearance(value => value + 1);
    const events = [BACKDROP_BLUR_EVENT, PANEL_SOLIDITY_EVENT, PANEL_OVERLAY_EVENT];
    events.forEach(event => window.addEventListener(event, refresh));
    return () => events.forEach(event => window.removeEventListener(event, refresh));
  }, []);
  const actionStyle = {backgroundColor: translucentPanelColor("--color-surface-2", panelSolidity(), panelOverlay()), backdropFilter: `blur(${backdropBlur()}px)`};
  const libraries = useQuery({ queryKey: ["native-libraries"], queryFn: nativeLibraries.list });
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
  return <section className="pb-6">
    <div className="relative mb-6 flex flex-wrap items-center justify-start gap-3">
      <button style={actionStyle} className="inline-flex items-center gap-2 rounded-full border border-border px-4 py-2.5 text-sm font-medium text-muted transition-colors hover:border-accent hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent" onClick={event => { trigger.current = event.currentTarget; setEditing("new"); }}><Plus className="size-4" />New Library</button>
      <button style={actionStyle} className="inline-flex items-center gap-2 rounded-full border border-border px-4 py-2.5 text-sm font-medium text-muted transition-colors hover:border-accent hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50" disabled={!libraries.data?.length || scanAll.isPending} onClick={() => scanAll.mutate()}><RefreshCw className={`size-4 ${scanAll.isPending ? "animate-spin" : ""}`} />Scan Libraries</button>
    </div>
    {scanAll.error && <p role="alert" className="mb-4 text-sm text-danger">{scanAll.error.message}</p>}
    {libraries.isPending && <p role="status" className="text-muted">Loading libraries…</p>}
    {libraries.error && <div role="alert" className="text-danger">{libraries.error.message} <button className={BUTTON} onClick={() => void libraries.refetch()}>Retry</button></div>}
    {libraries.data?.length === 0 && <div className="rounded-2xl border border-dashed border-edge p-10 text-center text-muted"><FolderPlus className="mx-auto mb-3 size-8 text-accent" /><p>No libraries yet.</p><p className="mt-1 text-sm">Choose a type and select folders inside /media to get started.</p></div>}
    <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">{libraries.data?.map(library => <LibraryCard key={library.id} library={library} onEdit={button=>{trigger.current=button;setEditing(library);}} />)}</div>
    {editing && <LibraryDialog library={editing === "new" ? undefined : editing} onClose={close} onSaved={() => { void client.invalidateQueries({ queryKey: ["native-libraries"] }); close(); }} />}
  </section>;
}

function LibraryCard({library,onEdit}:{library:NativeLibrary;onEdit:(button:HTMLButtonElement)=>void}) {
  const client = useQueryClient();
  const [confirmDelete,setConfirmDelete]=useState(false),[open,setOpen]=useState(false),[notices,setNotices]=useState(false),[scanDetails,setScanDetails]=useState(false);
  const previews=useQuery({queryKey:["native-previews",library.id],queryFn:()=>nativeLibraries.previews(library.id),enabled:open,staleTime:60_000});
  const menu=useRef<HTMLDivElement>(null), action=useRef<HTMLButtonElement>(null);
  const [refreshing,setRefreshing]=useState(false);
  const [position,setPosition]=useState({top:0,left:0});
  useEffect(()=>{if(!open)return;
    const place=()=>{const rect=action.current?.getBoundingClientRect();if(!rect)return;const width=Math.min(352,window.innerWidth-24);setPosition({left:Math.max(12,Math.min(rect.right-width,window.innerWidth-width-12)),top:Math.max(12,Math.min(rect.bottom+8,window.innerHeight-200))});};place();
    const close=(event:PointerEvent)=>{if(!menu.current?.contains(event.target as Node)&&!action.current?.contains(event.target as Node))setOpen(false);};
    const key=(event:KeyboardEvent)=>{if(event.key==="Escape"){setOpen(false);action.current?.focus();}};
    document.addEventListener("pointerdown",close);document.addEventListener("keydown",key);window.addEventListener("resize",place);window.addEventListener("scroll",place,true);
    return()=>{document.removeEventListener("pointerdown",close);document.removeEventListener("keydown",key);window.removeEventListener("resize",place);window.removeEventListener("scroll",place,true);};
  },[open]);
  const status = useQuery({queryKey:["native-scan",library.id],queryFn:()=>nativeLibraries.status(library.id),refetchInterval:query=>query.state.data?.status==="scanning"?2000:false});
  const scan=useMutation({mutationFn:()=>nativeLibraries.scan(library.id),onSuccess:()=>{void client.invalidateQueries({queryKey:["native-scan",library.id]});void client.invalidateQueries({queryKey:["native-previews",library.id]});}});
  const remove=useMutation({mutationFn:()=>nativeLibraries.remove(library.id,library.revision),onSuccess:()=>{setOpen(false);setConfirmDelete(false);client.setQueryData<NativeLibrary[]>(["native-libraries"],items=>items?.filter(item=>item.id!==library.id));void client.invalidateQueries({queryKey:["native-libraries"]});},onError:()=>setConfirmDelete(false)});
  const busy=status.data?.status==="scanning"||scan.isPending||remove.isPending;
  return <article className="group relative overflow-hidden rounded-xl bg-window">
    <div className="relative overflow-hidden rounded-xl"><LibraryPosterStrip library={library.id}/><button ref={action} aria-label={`Actions for ${library.name}`} aria-expanded={open} onClick={()=>setOpen(!open)} className={`absolute bottom-2 right-2 grid size-8 place-items-center rounded-full border border-white/15 bg-black/40 text-white backdrop-blur transition-opacity hover:bg-black/60 [@media(hover:hover)]:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 ${open ? "!opacity-100" : ""}`} data-icon-button="true"><MoreHorizontal className="size-4"/></button></div>
    <div className="flex min-h-24 flex-col bg-window px-4 pb-4 pt-2">
      <div className="text-center"><h3 className="truncate font-semibold text-white" title={library.name}>{library.name}</h3><p className="truncate text-xs text-muted" title={library.paths.map(displayPath).join("\n")}>{library.paths.length===1?displayPath(library.paths[0]):`${library.paths.length} folders`}</p></div>
      <div className="mt-3 min-h-0 overflow-y-auto text-xs text-muted">{status.data?.status === "scanning" && <NativeScanProgress status={status.data} compact/>}{scan.isPending && status.data?.status !== "scanning" && <p role="status">Starting scan…</p>}</div>
    </div>
    {open&&createPortal(<div ref={menu} role="region" aria-label={`Library actions for ${library.name}`} style={{...position,maxHeight:`calc(100dvh - ${position.top+12}px)`}} className="pv-popup-surface fixed z-[90] w-[min(22rem,calc(100vw-24px))] overflow-y-auto rounded-2xl p-4 text-white shadow-2xl">
        <div className="mb-3 flex items-center gap-3"><div aria-hidden="true" className="flex w-20 shrink-0 overflow-hidden rounded">{previews.data?.slice(0,4).map(item=><img key={item.id} src={sizedArtwork(nativeLibraries.artworkUrl(library.id,item.id,"poster")+`?v=${encodeURIComponent(item.artwork_version??String(item.revision))}`,96)} alt="" className="aspect-[2/3] w-1/4 object-cover"/>)}</div><p className="flex-1 font-semibold">{library.name}</p><button type="button" aria-label="Close library actions" className="rounded-lg p-2 text-muted hover:bg-elevated" onClick={()=>{setOpen(false);setConfirmDelete(false);}} data-icon-button="true"><X className="size-4"/></button></div>
        <div className="flex flex-col"><button className={`${MENU_ACTION} flex items-center justify-between`} onClick={()=>{setOpen(false);if(action.current)onEdit(action.current);}}>Library<Folder className="size-4"/></button><button className={`${MENU_ACTION} flex items-center justify-between`} disabled={scan.isPending||remove.isPending||status.data?.manual_queued} onClick={()=>scan.mutate()}>{status.data?.manual_queued?"Scan queued":"Scan Library Files"}<RefreshCw className="size-4"/></button>
        <button className={MENU_ACTION} disabled={remove.isPending} onClick={()=>{setOpen(false);setRefreshing(true);}}>Refresh Metadata</button>
        {status.data?.status==="scanning"&&<p role="status" className="px-3 py-2 text-xs text-muted">{status.data.manual_queued?"Manual scan queued. It will run when the current scan finishes.":"A scan is running. You can queue a manual scan."}</p>}
        {status.data?.status==="scanning"&&<button className={MENU_ACTION} aria-expanded={scanDetails} onClick={()=>setScanDetails(!scanDetails)}>{scanDetails?"Hide scan progress":"View scan progress"}</button>}
        {scanDetails&&status.data&&<section aria-label="Current library scan" className="px-3 py-2"><NativeScanProgress status={{...status.data,show_progress:true}}/>{status.data.manual_queued&&<p className="mt-2 text-xs text-muted">The manual scan will start after this scan finishes.</p>}</section>}
        <button className={MENU_ACTION} onClick={()=>setNotices(!notices)}>View notices / activity</button>
        {notices&&<div className="space-y-2 text-xs text-muted"><p className="font-medium text-white">Latest results</p>{[...(status.data?.warnings??[])].map((message,i)=><p key={i}>{message}</p>)}{!status.data?.warnings.length&&<p>No notices or activity.</p>}</div>}
        <div className="border-t border-edge pt-2"><button className={`${MENU_ACTION} flex w-full items-center justify-between text-danger`} disabled={busy} onClick={()=>setConfirmDelete(true)}>Remove<Trash2 className="size-4"/></button></div></div>
        {confirmDelete&&<div role="alertdialog" aria-label="Remove library confirmation" className="mt-3 rounded-xl border border-edge bg-base p-3"><p className="text-sm text-muted">Remove {library.name}? Media, NFO files, and local artwork will be kept.</p><div className="mt-3 flex gap-2"><button className={BUTTON} onClick={()=>{setConfirmDelete(false);setOpen(false);}}>Cancel</button><button className={`${BUTTON} text-danger`} disabled={busy} onClick={()=>remove.mutate()}>{remove.isPending?"Removing…":"Confirm removal"}</button></div></div>}
        {remove.error&&<p role="alert" className="mt-3 text-sm text-danger">{remove.error.message}</p>}
    </div>,document.body)}
    {refreshing&&<PopupPage title={`Refresh Metadata — ${library.name}`} onClose={()=>setRefreshing(false)}><SeriesActionsDialog action="refresh-metadata" library={library} wholeLibrary entry={{id:"",path:"",kind:"series",parent_path:null,title:library.name,metadata:{},artwork:[],files:[],nfo_path:null,available:true,revision:0}} entries={[]} onSaved={()=>{setRefreshing(false);setOpen(true);setScanDetails(true);void client.invalidateQueries({queryKey:["native-scan",library.id]});void client.invalidateQueries({queryKey:["native-catalog",library.id]});}}/></PopupPage>}
    {(scan.error||remove.error||status.error)&&<p role="alert" className="px-4 text-sm text-danger">{(scan.error||remove.error||status.error)?.message}</p>}
  </article>;
}

export function LibraryDialog({ library, seed, onClose, onSaved, portalContainer }: { library?: NativeLibrary; seed?: NativeLibraryInput; onClose: () => void; onSaved: () => void; portalContainer?: HTMLElement | null }) {
  const initial = useRef<NativeLibraryInput>(seed ?? (library ? { name: library.name, library_type: library.library_type, anime_content: library.anime_content, paths: library.paths, options: { ...defaultNativeOptions, ...library.options }, revision: library.revision } : { name: "", library_type: "movies", anime_content: "both", paths: [], options: { ...defaultNativeOptions }, revision: null }));
  const [draft, setDraft] = useState(initial.current);
  const client=useQueryClient();
  const revision=useRef<number|null>(library?.revision??null);
  const autoSave=useAutoSave({value:draft,enabled:!!library,save:async value=>{
    if(!library)return;
    if(!value.name.trim()||value.name.trim().length>120||value.paths.length===0||value.paths.length>32||overlap(value.paths))throw new Error("Enter a name and select 1–32 folders without overlaps.");
    const payload=value.library_type==="youtube"?{...value,options:{...defaultNativeOptions,...value.options,...youtubeOptions,youtube_mode:"multiple_channels" as const,youtube_channels:value.options?.youtube_channels?.map(channel=>channel.trim()).filter(Boolean)??[]}}:value.library_type==="books"?{...value,options:{...value.options!,allow_adult_metadata:true}}:value;
    const updated=await nativeLibraries.save({...payload,revision:revision.current},library.id);
    revision.current=updated.revision;
    void client.invalidateQueries({queryKey:["native-libraries"]});
  }});

  const [playbackRules,setPlaybackRules]=useState<WatchRules>({...defaultWatchRules});
  const [rulesChanged,setRulesChanged]=useState(false);
  const createdLibrary=useRef<NativeLibrary|null>(null);
  const [step, setStep] = useState(0);
  const [discard, setDiscard] = useState(false);
  const content = useRef<HTMLElement>(null);
  useEffect(() => { if (content.current) content.current.scrollTop = 0; }, [step]);
  const save = useMutation({ mutationFn: async () => {
    const payload=draft.library_type === "youtube" ? {...draft,options:{...defaultNativeOptions,...draft.options,...youtubeOptions,youtube_mode:"multiple_channels" as const,youtube_channels:draft.options?.youtube_channels?.map(value=>value.trim()).filter(Boolean)??[]}} : draft.library_type === "books" ? {...draft, options:{...draft.options!, allow_adult_metadata:true}} : draft;
    if(!library&&draft.library_type!=="books"&&!validWatchRules(playbackRules))throw new Error("Enter valid playback resume and completion rules.");
    const saved=await nativeLibraries.save(createdLibrary.current?{...payload,revision:createdLibrary.current.revision}:payload,library?.id??createdLibrary.current?.id);
    if(!library){
      createdLibrary.current=saved;
      if(rulesChanged&&draft.library_type!=="books"){
        try{await watchApi.saveRules(saved.id,playbackRules);}
        catch(error){throw new Error(`Library created, but playback rules could not be saved. Save again to retry without creating another library. ${error instanceof Error?error.message:""}`);}
      }
    }
    return saved;
  }, onSuccess: onSaved });
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial.current)||rulesChanged;
  const closeRef = useRef<() => void>(() => {});
  closeRef.current = () => { if (library||save.isPending) { onClose(); return; } if (dirty) { setDiscard(true); if(content.current)content.current.scrollTop=0; } else onClose(); };
  const toggle = (selected: string) => setDraft(previous => ({ ...previous, paths: previous.paths.includes(selected) ? previous.paths.filter(p => p !== selected) : [...previous.paths, selected] }));
  const pathsInvalid = draft.paths.length === 0 || draft.paths.length > 32 || overlap(draft.paths);
  const basicsInvalid = !draft.name.trim() || draft.name.trim().length > 120;
  return <PopupPage title={library ? "Edit library" : "Create library"} description="PosterView library" closeLabel="Close library dialog" onClose={() => closeRef.current()} portalContainer={portalContainer} bodyClassName="overflow-hidden p-0" footer={      <div className="flex w-full items-center justify-between gap-3"><button className={BUTTON} disabled={save.isPending} onClick={() => step ? setStep(draft.library_type === "books" && step === 6 ? 4 : step - 1) : closeRef.current()}>{step ? "Back" : "Cancel"}</button>{step < STEPS.length - 1 ? <button className="rounded-xl bg-accent px-5 py-2.5 text-sm font-medium text-base disabled:opacity-50" disabled={save.isPending || (step === 0 ? basicsInvalid : pathsInvalid)} onClick={() => setStep(draft.library_type === "books" && step === 4 ? 6 : step + 1)}>Next</button> : library ? <button className={BUTTON} onClick={onClose}>Done</button> : <button className="inline-flex items-center gap-2 rounded-xl bg-accent px-5 py-2.5 text-sm font-medium text-base disabled:opacity-50" disabled={basicsInvalid || pathsInvalid || save.isPending || (!library&&draft.library_type!=="books"&&!validWatchRules(playbackRules))} onClick={() => save.mutate()}>{save.isPending ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}{save.isPending ? "Saving…" : library ? "Save library" : "Create library"}</button>}</div>}>
      <div className="flex h-full min-h-0 flex-col sm:flex-row">
        <nav aria-label="Library setup sections" className="flex shrink-0 gap-2 overflow-x-auto bg-window border-b border-border p-3 sm:w-44 sm:shrink-0 sm:flex-col sm:border-b-0 sm:border-r">{STEPS.map((label,index)=>({label,index})).filter(({index})=>draft.library_type!=="books"||index!==5).map(({label,index},position) => <button key={label} aria-current={step === index ? "step" : undefined} disabled={save.isPending} onClick={() => setStep(index)} className={`flex shrink-0 items-center gap-2 rounded-xl px-3 py-2.5 text-sm ${step === index ? "bg-accent/15 text-accent" : "text-muted hover:bg-window"}`}><span className="text-xs opacity-60">{position + 1}</span>{label}</button>)}</nav>
        <main ref={content} className="min-h-0 flex-1 overflow-y-auto bg-sidebar p-6 sm:p-8">
          {discard && <div className="mb-5 rounded-xl border border-border bg-window p-4" role="alert"><p className="text-sm text-white">Discard your unsaved changes?</p><div className="mt-3 flex gap-2"><button className={BUTTON} onClick={() => setDiscard(false)}>Keep editing</button><button className={`${BUTTON} text-danger`} onClick={onClose}>Discard changes</button></div></div>}
          {step === 0 && <div className="space-y-6"><div><h3 className="font-medium text-white">General</h3><p className="mt-1 text-sm text-muted">Choose how this collection is organized.</p></div>
            <label className="block text-sm text-muted">Name<input autoComplete="off" maxLength={120} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} className={`${INPUT} mt-2`} placeholder="e.g. Anime, Movies, Manga" /></label>
            <label className="block text-sm text-muted">Library type<select className={`${INPUT} mt-2`} value={draft.library_type} onChange={e => setDraft({ ...draft, library_type: e.target.value as NativeLibraryType, name: !library&&!draft.name.trim()&&e.target.value==="youtube"?"YouTube":draft.name, options: {...defaultNativeOptions, ...draft.options, metadata_providers: {}, image_providers: {}, ...(e.target.value === "youtube" ? {...youtubeOptions,youtube_mode:"multiple_channels" as const} : {})} })}>{Object.entries(TYPES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            {draft.library_type === "mixed" && <p className="text-sm text-muted">Combine movies and TV shows in one library. Movies and series retain their own metadata, artwork, and playback settings.</p>}
            {draft.library_type === "youtube" && <p className="text-sm text-muted">Channels are grouped inside this library; open a channel to browse its playlists and videos. Downloads and metadata are configured in the YTDL plugin.</p>}
            {draft.library_type === "anime" && <label className="block text-sm text-muted">Anime content<select aria-label="Anime content" aria-describedby="anime-content-help" className={`${INPUT} mt-2`} value={draft.anime_content} onChange={e => setDraft({ ...draft, anime_content: e.target.value as NativeLibraryInput["anime_content"] })}><option value="both">Mixed</option><option value="shows">Shows only</option><option value="movies">Movies only</option></select><span id="anime-content-help" className="mt-2 block text-xs text-faint">Anime is a dedicated library type. Each title will retain its movie or series identity.</span></label>}
            {draft.library_type === "books" && <p className="rounded-xl bg-window p-4 text-sm text-muted">Your existing book reader and custom NFO metadata tools remain available. Native scanning preserves custom book NFO fields and identifies supported book files.</p>}
          </div>}
          {step === 1 && <div className="space-y-4"><div><h3 className="font-medium text-white">Media folders</h3><p className="mt-1 text-sm text-muted">Select media roots below. You can choose multiple folders and review them here before saving.</p></div>
            <FolderBrowser inline initial="" title="Select Media Folders" selected={draft.paths} onClose={()=>{}} onSelect={path=>setDraft(previous=>({...previous,paths:[...new Set([...previous.paths,path])]}))} onSelectMany={paths=>setDraft(previous=>({...previous,paths}))}/>
            <div className="rounded-xl bg-window p-4"><p className="mb-2 text-sm font-medium text-white">{draft.paths.length} folders selected</p><ul className="space-y-1">{draft.paths.map(selected => <li key={selected} className="flex items-center justify-between gap-2 text-xs text-muted"><span className="break-all">{displayPath(selected)}</span><button className="shrink-0 rounded-lg p-2 hover:text-danger" aria-label={`Remove ${displayPath(selected)}`} onClick={() => toggle(selected)} data-icon-button="true"><X className="size-4" /></button></li>)}</ul></div>
            {overlap(draft.paths) && <p role="alert" className="text-sm text-danger">Selected folders overlap. Select a parent folder or its children, rather than both.</p>}
            {draft.paths.length > 32 && <p role="alert" className="text-sm text-danger">Choose at most 32 folders.</p>}
          </div>}
          {[2, 3, 4, 5].includes(step) && <LibrarySettings libraryId={library?.id} playbackRules={playbackRules} onPlaybackRulesChange={value=>{setPlaybackRules(value);setRulesChanged(true);}} options={{...defaultNativeOptions, ...draft.options}} type={draft.library_type} animeContent={draft.anime_content} section={step} onChange={options => setDraft(previous => ({...previous, options}))} />}
          {step === 6 && <div className="space-y-5"><div><h3 className="font-medium text-white">Review your library</h3><p className="mt-1 text-sm text-muted">Folders are validated before the configuration is saved.</p></div><dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-3 text-sm"><dt className="text-faint">Name</dt><dd className="break-all text-white">{draft.name || "Not set"}</dd><dt className="text-faint">Type</dt><dd className="text-white">{TYPES[draft.library_type]}</dd>{draft.library_type === "anime" && <><dt className="text-faint">Content</dt><dd className="text-white">{draft.anime_content === "both" ? "Mixed" : draft.anime_content === "shows" ? "Shows only" : "Movies only"}</dd></>}</dl><div className="rounded-xl border border-border p-4"><h4 className="mb-2 text-sm text-white">Media roots</h4>{draft.paths.map(p => <p key={p} className="break-all text-sm text-muted">{displayPath(p)}</p>)}</div><p className="text-sm text-muted">New libraries scan after saving. Local files are written only when Save metadata to NFO is enabled. Existing libraries can be scanned from their library card.</p>{(basicsInvalid || pathsInvalid) && <p role="alert" className="text-sm text-danger">Enter a name and select 1–32 folders without overlaps before saving.</p>}</div>}
          {library&&<><p role="status" className="mt-4 text-sm text-muted">{autoSave.status==="saved"?"Changes saved automatically":autoSave.status==="saving"?"Saving changes…":autoSave.status==="pending"?"Changes will save automatically…":"Changes save automatically"}</p>{autoSave.error&&<p role="alert" className="mt-3 text-sm text-danger">{autoSave.error.message} <button type="button" onClick={autoSave.retry}>Retry</button></p>}</>}
          {save.error && <p role="alert" className="mt-5 text-sm text-danger">{save.error.message}</p>}
        </main>
      </div>
  </PopupPage>;
}
