import {useRef,useState} from "react";
import {useMutation,useQuery,useQueryClient} from "@tanstack/react-query";
import {ytdlCookies} from "./client";

const key=["ytdl-cookies"];
const button="rounded-lg border border-border px-4 py-2 text-sm hover:bg-elevated disabled:opacity-50";
export default function YtdlCookieSettings(){
 const client=useQueryClient(),fileInput=useRef<HTMLInputElement>(null),selection=useRef(0);
 const [cookies,setCookies]=useState(""),[filename,setFilename]=useState(""),[fileError,setFileError]=useState("");
 const status=useQuery({queryKey:key,queryFn:ytdlCookies.status});
 const clear=()=>{selection.current++;setCookies("");setFilename("");if(fileInput.current)fileInput.current.value="";};
 const save=useMutation({mutationFn:()=>ytdlCookies.save(cookies),onSuccess:result=>{client.setQueryData(key,result);clear();}});
 const remove=useMutation({mutationFn:ytdlCookies.remove,onSuccess:result=>{client.setQueryData(key,result);clear();save.reset();}});
 const busy=save.isPending||remove.isPending;
 const error=fileError||status.error?.message||save.error?.message||remove.error?.message;
 return <section aria-labelledby="youtube-authentication" className="space-y-3 rounded-xl border border-border p-4">
  <h3 id="youtube-authentication" className="font-semibold">YouTube authentication</h3>
  <p className="text-sm text-muted">Cookies are used only after YouTube requires authentication. Public requests run without cookies. This applies to downloads, metadata refreshes, and subscriptions.</p>
  <p className="text-xs text-muted">Cookie files contain sensitive account session data. Export youtube.com cookies only, in Netscape cookies.txt format (maximum 1 MiB), from an account that can access the video. Contents are stored privately on the server and are never displayed here.</p>
  {status.isPending?<p role="status" className="text-sm">Checking authentication…</p>:<p className="text-sm">{status.error?"Authentication status unavailable":status.data?.configured?"Cookies configured":"No cookies configured"}{status.data?.updated_at&&<> · Updated {new Date(status.data.updated_at).toLocaleString()}</>}</p>}
  <label className="block text-sm">YouTube cookie file<input ref={fileInput} aria-label="YouTube cookie file" type="file" accept=".txt,text/plain" disabled={busy} className="mt-2 block w-full text-sm" onChange={async event=>{const file=event.target.files?.[0],version=++selection.current;setCookies("");setFilename("");setFileError("");save.reset();remove.reset();if(!file)return;if(file.size>1024*1024){setFileError("Cookie files must be 1 MiB or smaller.");return;}try{const text=await file.text();if(selection.current!==version)return;if(!text.trim()){setFileError("The cookie file is empty.");return;}setCookies(text);setFilename(file.name);}catch{if(selection.current===version)setFileError("Could not read the cookie file.");}}}/></label>
  {filename&&<p className="text-xs text-muted">{filename} selected. Save cookies to upload this file.</p>}
  <div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={!cookies||busy} onClick={()=>save.mutate()}>{save.isPending?"Saving cookies…":status.data?.configured?"Replace cookies":"Save cookies"}</button><button type="button" className={button} disabled={!status.data?.configured||busy} onClick={()=>remove.mutate()}>{remove.isPending?"Removing cookies…":"Remove cookies"}</button></div>
  {save.isSuccess&&<p role="status" className="text-sm text-accent">Cookies saved.</p>}{remove.isSuccess&&<p role="status" className="text-sm">Cookies removed.</p>}
  {error&&<p role="alert" className="text-sm text-danger">{error}</p>}
 </section>;
}
