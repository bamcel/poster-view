type Named = {id:string;name?:string;title?:string;kind?:string;path?:string;parent_path?:string|null};
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
export function itemPath(library:Named, libraries:Named[], item:Named, entries:Named[]) {
 const parent=item.kind==="season" ? entries.find(entry=>entry.path===item.parent_path && entry.kind==="series") : undefined;
 if(parent) {
  const siblings=entries.filter(entry=>entry.parent_path===parent.path && entry.kind==="season");
  return `${libraryPath(library,libraries)}/${encodeURIComponent(namedSlug(parent,entries.filter(entry=>entry.kind==="series")))}/${encodeURIComponent(namedSlug(item,siblings))}`;
 }
 return `${libraryPath(library,libraries)}/${encodeURIComponent(namedSlug(item,entries))}`;
}
