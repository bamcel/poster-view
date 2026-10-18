import {useEffect,useRef,useState} from "react";

export type AutoSaveStatus="idle"|"pending"|"saving"|"saved"|"error";
/** Debounce valid drafts and serialize writes, preserving changes made during a request. */
export function useAutoSave<T>({value,enabled=true,save,delay=600}:{value:T;enabled?:boolean;save:(value:T)=>Promise<unknown>;delay?:number}){
 const [status,setStatus]=useState<AutoSaveStatus>("idle");
 const [error,setError]=useState<Error|null>(null);
 const state=useRef({initialized:false,ack:"",latest:value,signature:JSON.stringify(value),enabled,save,running:false,mounted:true,timer:undefined as ReturnType<typeof setTimeout>|undefined,failed:""});
 const current=state.current;current.latest=value;current.signature=JSON.stringify(value);current.enabled=enabled;current.save=save;
 const drain=useRef<()=>Promise<void>>(async()=>{});
 drain.current=async()=>{
  const s=state.current;
  if(s.running||!s.enabled||!s.initialized||s.signature===s.ack)return;
  s.running=true;
  if(s.mounted){setStatus("saving");setError(null);}
  let attempted=s.signature;
  try{
   while(s.enabled&&s.signature!==s.ack){
    const snapshot=s.latest,signature=s.signature;attempted=signature;
    await s.save(snapshot);s.ack=signature;s.failed="";
   }
   if(s.mounted)setStatus(s.signature===s.ack?"saved":"pending");
  }catch(cause){
   s.failed=attempted;
   if(s.signature!==attempted&&s.enabled){
    if(s.mounted){setError(null);setStatus("pending");}
    clearTimeout(s.timer);s.timer=setTimeout(()=>void drain.current(),delay);
   }else if(s.mounted){setError(cause instanceof Error?cause:new Error(String(cause)));setStatus("error");}
  }
  finally{s.running=false;}
 };
 const signature=current.signature;
 useEffect(()=>{
  const s=state.current;
  clearTimeout(s.timer);
  if(!enabled)return;
  if(!s.initialized){s.initialized=true;s.ack=signature;return;}
  if(signature===s.ack){if(!s.running)setStatus(previous=>previous==="idle"?"idle":"saved");return;}
  if(s.running)return;
  setError(null);setStatus("pending");
  s.timer=setTimeout(()=>void drain.current(),delay);
  return()=>clearTimeout(s.timer);
 },[signature,enabled,delay]);
 useEffect(()=>{
  const s=state.current;s.mounted=true;
  const unload=(event:BeforeUnloadEvent)=>{if(s.initialized&&s.signature!==s.ack){event.preventDefault();event.returnValue="";}};
  window.addEventListener("beforeunload",unload);
  return()=>{s.mounted=false;clearTimeout(s.timer);window.removeEventListener("beforeunload",unload);if(!s.failed)void drain.current();};
 },[]);
 return {status,error,retry:()=>{state.current.failed="";void drain.current();}};
}
