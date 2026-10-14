import {useState} from "react";
import {ChevronRight,Folder} from "lucide-react";
import FolderBrowser from "../../../components/FolderBrowser";

export default function DownloadDirectoryPicker({value,onChange}:{value:string;onChange:(value:string)=>void}){
 const [open,setOpen]=useState(false);
 return <section className="space-y-2"><p className="text-sm font-medium">Download directory</p><button type="button" aria-label="Download directory" aria-haspopup="dialog" aria-expanded={open} className="flex w-full items-center gap-3 rounded-xl border border-border bg-input px-4 py-3 text-left hover:bg-elevated focus-visible:outline focus-visible:outline-accent" onClick={()=>setOpen(true)}><Folder className="size-5 shrink-0 text-accent"/><span className="min-w-0 flex-1"><span className="block break-all text-sm">/media{value?`/${value}`:""}</span><span className="block text-xs text-muted">Browse for a download folder</span></span><ChevronRight className="size-4 text-muted"/></button>{open&&<FolderBrowser initial={value} onClose={()=>setOpen(false)} onSelect={path=>{onChange(path);setOpen(false);}}/>}<p className="text-xs text-muted">Choose an existing folder under /media. Save configuration to apply.</p></section>;
}
