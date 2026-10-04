import {useState} from "react";
import {createPortal} from "react-dom";
import {useQuery} from "@tanstack/react-query";
import {X} from "lucide-react";
import {api} from "../api/client";
import {defaultNativeOptions,defaultServerSync,type NativeLibraryInput} from "../api/nativeLibraries";
import {LibraryDialog} from "./NativeLibrariesSection";

export default function ImportServerLibrary({onClose,onSaved}:{onClose:()=>void;onSaved:()=>void}) {
 const [server,setServer]=useState<number|null>(null),[library,setLibrary]=useState(""),[seed,setSeed]=useState<NativeLibraryInput>();
 const servers=useQuery({queryKey:["servers"],queryFn:api.listServers});
 const libraries=useQuery({queryKey:["integration-libraries",server],queryFn:()=>api.getIntegrationLibraries(server!),enabled:server!==null});
 const selected=libraries.data?.find(l=>l.id===library);
 if(seed)return <LibraryDialog seed={seed} onClose={onClose} onSaved={onSaved}/>;
 return createPortal(<div className="fixed inset-0 z-[80] grid place-items-center bg-black/60 p-4"><section role="dialog" aria-modal="true" aria-label="Import library" className="w-full max-w-lg rounded-2xl bg-sidebar p-6 text-white shadow-2xl"><header className="mb-5 flex items-center justify-between"><h2 className="text-lg font-semibold">Import library from server</h2><button aria-label="Close import library" onClick={onClose}><X className="size-5"/></button></header><p className="mb-5 text-sm text-muted">Choose a server library, then map its media folders to PosterView’s /media mount. This creates a PosterView library and imports matching metadata after its initial scan.</p><label className="block text-sm">Server<select aria-label="Import library server" value={server??""} onChange={e=>{setServer(Number(e.target.value)||null);setLibrary("");}} className="my-2 w-full rounded-lg bg-surface-2 p-3"><option value="">Select server</option>{servers.data?.map(s=><option key={s.id} value={s.id} disabled={s.type==="plex"}>{s.name}{s.type==="plex"?" · metadata import unavailable":""}</option>)}</select></label><label className="block text-sm">Server library<select aria-label="Library to import" value={library} onChange={e=>setLibrary(e.target.value)} disabled={!server} className="my-2 w-full rounded-lg bg-surface-2 p-3"><option value="">Select library</option>{libraries.data?.map(l=><option key={l.id} value={l.id}>{l.title}</option>)}</select></label>{(servers.error||libraries.error)&&<p role="alert" className="text-danger">{(servers.error||libraries.error)?.message}</p>}<button disabled={!server||!selected} onClick={()=>{if(!server||!selected)return;setSeed({name:selected.title,library_type:/anime/i.test(selected.title)?"anime":selected.type==="movie"?"movies":["book","audiobook"].includes(selected.type)?"books":"shows",anime_content:"both",paths:[],revision:null,options:{...defaultNativeOptions,fetch_missing:false,server_sync:{...defaultServerSync,enabled:true,mode:"import_only",server_id:server,library_id:library,override_locked:true,push_to_all:false}}});}} className="mt-4 rounded-lg bg-accent px-4 py-3 font-medium text-black disabled:opacity-50">Continue to folder mapping</button></section></div>,document.body);
}
