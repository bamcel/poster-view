type Named = {id:string;name?:string;title?:string;kind?:string;path?:string;parent_path?:string|null;metadata?:Record<string,unknown>};
export function mediaSlug(value:string) {
 return value.normalize("NFKC").trim().replace(/[\/\\?#%]+/g,"-").replace(/\s+/g,"-") || "Untitled";
}
export function namedSlug(item:Named, peers:Named[]) {
 const slug=mediaSlug(item.name??item.title??"");
 return peers.filter(peer=>mediaSlug(peer.name??peer.title??"").toLowerCase()===slug.toLowerCase()).length>1 ? `${slug}~${item.id}` : slug;
}
export function resolveNamed<T extends Named>(value:string|undefined, peers:T[]):T|undefined {
 const byId=peers.find(item=>item.id===value);
 if(byId)return byId;
 const suffixed=peers.find(item=>value===`${mediaSlug(item.name??item.title??"")}~${item.id}`);
 if(suffixed)return suffixed;
 const matches=peers.filter(item=>mediaSlug(item.name??item.title??"")===value);
 return matches.length===1?matches[0]:undefined;
}
export function libraryPath(library:Named, peers:Named[]=[]) {
 return `/media/${encodeURIComponent(namedSlug(library,peers))}`;
}
function numberedTitle(item:Named) {
 const field=item.kind==="season"?"season":"episode";
 const value=item.metadata?.[field] ?? (item.kind==="season" ? item.title?.match(/^Season\s+(\d+)$/i)?.[1] : undefined);
 const number=Number(value);
 return value!=null && Number.isInteger(number)&&number>=0 ? `${item.kind==="season"?"Season":"Episode"}-${String(number).padStart(2,"0")}` : mediaSlug(item.title??"");
}
export function numberedSlug(item:Named,peers:Named[]) {
 const slug=numberedTitle(item);
 return peers.filter(peer=>numberedTitle(peer)===slug).length>1?`${slug}~${item.id}`:slug;
}
export function resolveNumbered<T extends Named>(value:string|undefined,peers:T[]) {
 const matches=peers.filter(item=>numberedSlug(item,peers)===value);
 return matches.length===1?matches[0]:resolveNamed(value,peers);
}
export function itemPath(library:Named, libraries:Named[], item:Named, entries:Named[]):string {
 const parent=entries.find(entry=>entry.path===item.parent_path);
 if(item.kind==="episode"&&parent?.kind==="season") {
  return `${itemPath(library,libraries,parent,entries)}/${encodeURIComponent(numberedSlug(item,entries.filter(entry=>entry.kind==="episode"&&entry.parent_path===parent.path)))}`;
 }
 if(item.kind==="season"&&parent?.kind==="series") {
  const siblings=entries.filter(entry=>entry.parent_path===parent.path && entry.kind==="season");
  return `${libraryPath(library,libraries)}/${encodeURIComponent(namedSlug(parent,entries.filter(entry=>entry.kind==="series")))}/${encodeURIComponent(numberedSlug(item,siblings))}`;
 }
 return `${libraryPath(library,libraries)}/${encodeURIComponent(namedSlug(item,entries))}`;
}
