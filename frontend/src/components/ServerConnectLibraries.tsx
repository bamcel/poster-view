import {useState} from "react";
import {useMutation,useQuery,useQueryClient} from "@tanstack/react-query";
import {defaultNativeOptions,defaultServerSync,nativeLibraries,type NativeLibrary,type ServerSyncOptions} from "../api/nativeLibraries";
import ConnectedServerSync from "./ConnectedServerSync";

export default function ServerConnectLibraries({enabled}:{enabled:boolean}) {
 const libraries=useQuery({queryKey:["native-libraries"],queryFn:nativeLibraries.list});
 const [selected,setSelected]=useState("");
 const available=libraries.data?.filter(l=>l.library_type!=="books")??[];
 const library=available.find(l=>l.id===selected)??available[0];
 return <section className="mt-6 border-t border-border pt-6"><h3 className="font-semibold">Library connections</h3><p className="mt-2 text-sm text-muted">Connect libraries here to import metadata, synchronize changes, or manually push selected fields to servers.</p>
 <label className="mt-4 block text-sm">PosterView library<select aria-label="PosterView library connection" className="mt-2 w-full rounded border border-border bg-input px-3 py-2.5 text-white" value={library?.id??""} onChange={e=>setSelected(e.target.value)}>{!available.length&&<option value="">No video libraries available</option>}{available.map(l=><option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
 {libraries.error&&<p role="alert" className="text-danger">{libraries.error.message}</p>}
 {library&&<Connection key={`${library.id}:${library.revision}`} library={library} enabled={enabled}/>}
 </section>;
}
function Connection({library,enabled}:{library:NativeLibrary;enabled:boolean}) {
 const client=useQueryClient();
 const [value,setValue]=useState<ServerSyncOptions>(library.options?.server_sync??defaultServerSync);
 const dirty=JSON.stringify(value)!==JSON.stringify(library.options?.server_sync??defaultServerSync);
 const save=useMutation({mutationFn:()=>nativeLibraries.save({name:library.name,library_type:library.library_type,anime_content:library.anime_content,paths:library.paths,revision:library.revision,options:{...defaultNativeOptions,...library.options,server_sync:value}},library.id),onSuccess:async()=>{await Promise.all([client.invalidateQueries({queryKey:["native-libraries"]}),client.invalidateQueries({queryKey:["native-sync",library.id]})]);}});
 return <div className="mt-5 space-y-4"><fieldset disabled={!enabled||save.isPending} className="space-y-4 disabled:opacity-50"><ConnectedServerSync flat value={value} onChange={setValue} library={dirty?undefined:library.id}/><button className="rounded-full border border-border bg-surface-2 px-4 py-2 text-sm disabled:opacity-50" disabled={!dirty} onClick={()=>save.mutate()}>{save.isPending?"Saving…":"Save connection"}</button></fieldset>{dirty&&<p className="text-xs text-muted">Save the connection before running sync actions.</p>}{!enabled&&<p className="text-xs text-muted">Enable Server Connect to configure connections or run tasks.</p>}{save.error&&<p role="alert" className="text-danger">{save.error.message}</p>}</div>;
}
