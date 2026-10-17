import { useEffect,useId, useState, type ReactNode } from "react";
import { CheckCircle2, ChevronDown, ExternalLink,Loader2,PlugZap } from "lucide-react";
import {SETTINGS_BUTTON} from "./SettingsPageFrame";

const verificationKey=(id:string)=>`posterview.providerVerified.${id}`;
const verified=(id:string)=>{try{return localStorage.getItem(verificationKey(id))==="true";}catch{return false;}};
export function TestConnectionButton({pending,disabled,onClick}:{pending:boolean;disabled:boolean;onClick:()=>void}){return <button type="button" className={SETTINGS_BUTTON} disabled={disabled||pending} onClick={onClick}>{pending?<Loader2 aria-hidden="true" className="size-4 animate-spin"/>:<PlugZap aria-hidden="true" className="size-4"/>}{pending?"Testing…":"Test Connection"}</button>;}

export default function ProviderConnection({ id, name, description, status, setupUrl, setupLabel = "Get credentials", children }: {
  id: string; name: string; description: string; status: string; setupUrl: string; setupLabel?: string; children: ReactNode;
}) {
  const key = `posterview.providerExpanded.${id}`;
  const [open, setOpen] = useState(() => sessionStorage.getItem(key) === "true");
  const contentId = useId();
  const [lastVerified,setVerified]=useState(()=>verified(id));
  const record=(value:boolean)=>{setVerified(value);try{if(value)localStorage.setItem(verificationKey(id),"true");else localStorage.removeItem(verificationKey(id));}catch{/* Feedback remains available for this visit. */}window.dispatchEvent(new CustomEvent("posterview:provider-verification",{detail:id}));};
  useEffect(()=>{if(status==="Connection verified")record(true);else if(status==="Connection failed"||status==="Not configured")record(false);},[id,status]);
  useEffect(()=>{const sync=()=>setVerified(verified(id));window.addEventListener("storage",sync);window.addEventListener("posterview:provider-verification",sync);return()=>{window.removeEventListener("storage",sync);window.removeEventListener("posterview:provider-verification",sync);};},[id]);
  const confirmed=lastVerified&&status!=="Connection failed"&&status!=="Not configured";
  const displayStatus=confirmed&&status==="Credentials saved"?"Connection verified":!confirmed&&status==="Connection verified"?"Credentials saved":status;
  return <section aria-label={`${name} connection`} className="border-b border-border" onChangeCapture={event=>{if(event.target instanceof HTMLInputElement)record(false);}}>
    <h3>
      <button type="button" aria-label={`Configure ${name}`} aria-expanded={open} aria-controls={contentId}
        onClick={() => { const next = !open; setOpen(next); sessionStorage.setItem(key, String(next)); }}
        className="flex w-full items-center gap-3 px-4 py-4 text-left transition-colors hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
        <span className="min-w-0 flex-1 sm:grid sm:grid-cols-[minmax(9rem,1fr)_2fr] sm:items-center sm:gap-4">
          <span className="flex items-center gap-2 text-sm font-semibold">
            <span className="size-4 shrink-0">{confirmed && <CheckCircle2 className="size-4 text-green-500" role="img" aria-label={`${name} connection verified`} />}</span>
            {name}
          </span>
          <span className="mt-1 block text-xs font-normal text-faint sm:mt-0">{description}</span>
        </span>
        <span className="max-w-24 shrink-0 text-right sm:max-w-none sm:w-36 text-xs font-normal text-muted">{displayStatus}</span>
        <ChevronDown className={`size-4 shrink-0 text-muted transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" />
      </button>
    </h3>
    <div id={contentId} hidden={!open} className="border-t border-border bg-surface-2 px-4 py-4">
      <div className="mb-4 flex justify-end"><a href={setupUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-white">{setupLabel}<ExternalLink className="size-3.5" aria-hidden="true" /></a></div>
      <div className="w-full">{children}</div>
    </div>
  </section>;
}

export function providerStatus(configured: boolean | undefined, pending = false, result?: { ok: boolean }, error?: unknown) {
  if (pending) return "Testing…";
  if (error || result?.ok === false) return "Connection failed";
  if (result?.ok) return "Connection verified";
  return configured === undefined ? "Checking configuration…" : configured ? "Credentials saved" : "Not configured";
}
