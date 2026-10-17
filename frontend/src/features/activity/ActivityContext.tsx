import {createContext,useCallback,useContext,useEffect,useMemo,useState,type ReactNode} from "react";
import {AuthSessionContext,useIsAdmin} from "../../lib/authContext";

export interface ActivityItem {
 id:string;title:string;detail:string;state:"running"|"queued"|"completed"|"failed"|"warning";
 progress?:number|null;href?:string;event?:string;updatedAt?:number;adminOnly?:boolean;
 jobId?:string;canCancel?:boolean;canRetry?:boolean;cancelling?:boolean;
}
type Feed={scope:string;sources:Record<string,readonly ActivityItem[]>;dismissed:Record<string,string>};
type ActivityContextValue={items:ActivityItem[];dismiss:(id:string)=>void;clearFinished:()=>void;publish:(source:string,items:readonly ActivityItem[])=>void};
const Context=createContext<ActivityContextValue>({items:[],dismiss:()=>{},clearFinished:()=>{},publish:()=>{}});
export const activityRunning=(item:ActivityItem)=>item.state==="running"||item.state==="queued";
const signature=(item:ActivityItem)=>JSON.stringify(item);
const dismissalKey=(scope:string)=>`posterview.activity.dismissed:${scope}`;
function loadDismissed(scope:string):Feed["dismissed"]{
 try{
  const value:unknown=JSON.parse(localStorage.getItem(dismissalKey(scope))??"{}");
  return value&&typeof value==="object"&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).filter(([,signature])=>typeof signature==="string").slice(-500)):{};
 }catch{return {};}
}
function flatten(sources:Feed["sources"]):ActivityItem[]{return Object.entries(sources).flatMap(([source,items])=>items.slice(0,100).map(item=>({...item,id:`${source}:${item.id}`,progress:typeof item.progress==="number"&&Number.isFinite(item.progress)?Math.max(0,Math.min(100,item.progress)):null})));}
export function ActivityProvider({children}:{children:ReactNode}){
 const user=useContext(AuthSessionContext)?.user,isAdmin=useIsAdmin();
 const scope=`${user?.id??"local"}:${user?.role??"admin"}`;
 const [feed,setFeed]=useState<Feed>(()=>({scope,sources:{},dismissed:loadDismissed(scope)}));
 const [now,setNow]=useState(Date.now);
 useEffect(()=>{
  if(feed.scope!==scope)return;
  try{localStorage.setItem(dismissalKey(scope),JSON.stringify(Object.fromEntries(Object.entries(feed.dismissed).slice(-500))));}catch{/* Dismissal still works in memory when storage is unavailable. */}
 },[feed.dismissed,feed.scope,scope]);
 useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),30_000);return()=>clearInterval(timer);},[]);
 const publish=useCallback((source:string,items:readonly ActivityItem[])=>{
  setFeed(previous=>{
   const value=previous.scope===scope?previous:{scope,sources:{},dismissed:loadDismissed(scope)};
   if(JSON.stringify(value.sources[source]??[])===JSON.stringify(items))return value;
   const sources={...value.sources};if(items.length)sources[source]=items;else delete sources[source];
   return {...value,sources};
  });
 },[scope]);
 const items=useMemo(()=>{
  if(feed.scope!==scope)return [];
  const rank=(item:ActivityItem)=>activityRunning(item)?0:item.state==="failed"||item.state==="warning"?1:2;
  return flatten(feed.sources).filter(item=>(isAdmin||!item.adminOnly)&&feed.dismissed[item.id]!==signature(item)&&(item.state!=="completed"||item.updatedAt!==undefined&&now-item.updatedAt<30*60_000))
   .sort((a,b)=>rank(a)-rank(b)||(b.updatedAt??0)-(a.updatedAt??0)||a.id.localeCompare(b.id)).slice(0,50);
 },[feed,scope,isAdmin,now]);
 const dismiss=useCallback((id:string)=>setFeed(previous=>{
  if(previous.scope!==scope)return previous;
  const item=flatten(previous.sources).find(item=>item.id===id);
  return item&&!activityRunning(item)?{...previous,dismissed:{...previous.dismissed,[id]:signature(item)}}:previous;
 }),[scope]);
 const clearFinished=useCallback(()=>setFeed(previous=>{
  if(previous.scope!==scope)return previous;
  const dismissed={...previous.dismissed};for(const item of flatten(previous.sources))if(!activityRunning(item))dismissed[item.id]=signature(item);
  return {...previous,dismissed};
 }),[scope]);
 const value=useMemo(()=>({items,dismiss,clearFinished,publish}),[items,dismiss,clearFinished,publish]);
 return <Context.Provider value={value}>{children}</Context.Provider>;
}
export const useActivity=()=>useContext(Context);
/** A globally mounted adapter can publish persistent server jobs; feature UI can
 * publish its own transient work with the same source-scoped interface. */
export function useActivitySource(source:string,items:readonly ActivityItem[],enabled=true){
 const {publish}=useActivity();const serialized=JSON.stringify(enabled?items:[]);
 useEffect(()=>{publish(source,JSON.parse(serialized) as ActivityItem[]);return()=>publish(source,[]);},[source,serialized,publish]);
}
