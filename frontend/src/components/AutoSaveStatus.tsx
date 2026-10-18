import type {AutoSaveStatus as Status} from "../lib/useAutoSave";
export default function AutoSaveStatus({status,error,retry}:{status:Status;error?:Error|null;retry?:()=>void}){
 if(status==="idle")return null;
 return <p role={status==="error"?"alert":"status"} className={`text-xs ${status==="error"?"text-danger":"text-muted"}`} aria-live="polite">{status==="error"?`Changes could not be saved. ${error?.message??""}`:status==="saved"?"Changes saved automatically":status==="saving"?"Saving changes…":"Changes will save automatically…"}{status==="error"&&retry&&<button type="button" className="ml-2 underline" onClick={retry}>Retry</button>}</p>;
}
