import PluginCard from "./PluginCard";
import {useEffect,useRef,useState} from "react";
import {createPortal} from "react-dom";
import {useQuery,useMutation,useQueryClient} from "@tanstack/react-query";
import {X} from "lucide-react";
import {apiRequest} from "../api/client";
type Settings={enabled:boolean;configured:boolean};
export default function GoogleBooksPlugin(){
 const [open,setOpen]=useState(false);
 const settings=useQuery({queryKey:["plugin-google-books"],queryFn:()=>apiRequest<Settings>("/plugins/google-books")});
 return <><PluginCard title="Google Books" description="Search book editions and pull titles, authors, descriptions, publishers, ISBNs, and other book metadata." status={settings.data?.enabled&&settings.data.configured?"Enabled · API key saved":"Configure API connection"} onClick={()=>setOpen(true)} bannerClassName="bg-[linear-gradient(115deg,#4285f4_0%,#4285f4_25%,#ea4335_50%,#fbbc05_75%,#34a853_100%)]" branding={<div className="rounded-lg bg-white px-4 py-3 shadow-sm"><img src="/plugins/google-logo.png" alt="" className="h-10 w-auto"/><span className="block text-right text-sm leading-none text-[#4285f4]">Books</span></div>}/>{open&&<GoogleBooksPopup onClose={()=>setOpen(false)}/>}</>;
}
export function GoogleBooksPopup({onClose}:{onClose:()=>void}){
 const dialog=useRef<HTMLDialogElement>(null),client=useQueryClient();
 const [key,setKey]=useState(""),[enabled,setEnabled]=useState(false),[notice,setNotice]=useState("");
 const settings=useQuery({queryKey:["plugin-google-books"],queryFn:()=>apiRequest<Settings>("/plugins/google-books")});
 useEffect(()=>{dialog.current?.showModal();},[]);
 useEffect(()=>{if(settings.data)setEnabled(settings.data.enabled);},[settings.data]);
 const save=useMutation({mutationFn:(clear:boolean)=>apiRequest<Settings>("/plugins/google-books",{method:"PUT",body:JSON.stringify({enabled:clear?false:enabled,api_key:key||undefined,clear_key:clear})}),onSuccess:value=>{client.setQueryData(["plugin-google-books"],value);setKey("");setNotice("Configuration saved.");}});
 const test=useMutation({mutationFn:()=>apiRequest<{message:string}>("/plugins/google-books/test",{method:"POST",body:JSON.stringify({api_key:key.trim()||undefined})}),onSuccess:value=>setNotice(value.message)});
 const busy=save.isPending||test.isPending;
 return createPortal(<dialog ref={dialog} onCancel={onClose} aria-label="Google Books configuration" className="fixed inset-0 m-auto max-h-[85dvh] w-[min(34rem,calc(100vw-2rem))] overflow-y-auto rounded-2xl border border-border bg-sidebar p-6 text-white shadow-2xl backdrop:bg-black/60"><header className="mb-6 flex items-center justify-between"><h2 className="text-lg font-semibold">Google Books</h2><button aria-label="Close Google Books" onClick={onClose}><X className="size-5"/></button></header>
 <div className="space-y-5"><p className="text-sm text-muted">Enable Books API in your Google Cloud project and create an API key. This connects public book metadata; signing in with Google is not required.</p><a href="https://console.cloud.google.com/apis/library/books.googleapis.com" target="_blank" rel="noreferrer" className="inline-block text-sm text-accent hover:underline">Open Google Books API setup</a>
 <label className="flex items-center justify-between text-sm">Enable Google Books<input type="checkbox" checked={enabled} disabled={!settings.data||busy} onChange={event=>setEnabled(event.target.checked)}/></label>
 <label className="block text-sm">API key<input type="password" autoComplete="off" value={key} disabled={!settings.data||busy} onChange={event=>{setKey(event.target.value);setNotice("");test.reset();save.reset();}} placeholder={settings.data?.configured?"Key saved — enter a replacement":"Google Books API key"} className="mt-2 w-full rounded-lg border border-border bg-input px-3 py-2"/></label>
 <p className="text-xs text-muted">Keys are encrypted on the server. Leave this field blank to keep your saved key. Restrict the key to Books API; browser referrer restrictions do not support server requests.</p>
 <div className="flex flex-wrap gap-3"><button disabled={!settings.data||busy} onClick={()=>save.mutate(false)} className="rounded-lg bg-accent px-4 py-2 text-sm text-black disabled:opacity-50">{save.isPending?"Saving…":"Save configuration"}</button><button disabled={busy||(!key.trim()&&!settings.data?.configured)} onClick={()=>{setNotice("");test.reset();test.mutate();}} className="rounded-lg border border-border px-4 py-2 text-sm disabled:opacity-50">{test.isPending?"Testing…":"Test connection"}</button>{settings.data?.configured&&<button disabled={busy} onClick={()=>save.mutate(true)} className="text-sm text-danger">Remove API key</button>}</div>
 {test.isPending&&<p role="status" className="rounded-lg border border-border bg-elevated p-3 text-sm text-muted">Testing Google Books connection…</p>}
 {notice&&<p role="status" className="rounded-lg border border-accent/40 bg-accent/10 p-3 text-sm font-medium text-accent">{notice}</p>}
 {test.error&&<p role="alert" className="rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">Google Books connection failed: {test.error.message}</p>}
 <p className="text-xs text-muted">After connecting, enable Google Books under your book library’s metadata providers. Use Identify to select an edition, then Fetch Metadata or Refresh Metadata.</p>
 {(settings.error||save.error)&&<p role="alert" className="text-sm text-danger">{(settings.error||save.error)?.message}</p>}
 </div></dialog>,document.body);
}
