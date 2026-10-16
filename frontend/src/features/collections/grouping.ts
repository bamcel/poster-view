import type {NativeCatalogEntry} from "../../api/nativeLibraries";
import {memberKey,type Collection} from "./client";

export function groupLibraryTitles(entries:NativeCatalogEntry[],collections:Collection[],libraryId:string){
 const visible=new Set(entries.filter(entry=>entry.available&&entry.metadata.missing!==true&&["movie","series"].includes(entry.kind)).map(entry=>entry.id));
 const hidden=new Set<string>();
 const grouped=collections.flatMap(collection=>{
  const ids=new Set(collection.members.filter(member=>member.library_id===libraryId&&visible.has(member.item_id)).map(member=>member.item_id));
  if(ids.size<2)return [];
  ids.forEach(id=>hidden.add(id));return [{...collection,members:collection.members.filter(member=>member.library_id===libraryId&&ids.has(member.item_id))}];
 });
 return {collections:grouped,entries:entries.filter(entry=>!hidden.has(entry.id))};
}
export function uniqueMembers<T extends {library_id:string;item_id:string}>(members:T[]):T[]{return [...new Map(members.map(member=>[memberKey(member),member])).values()];}
export function orderedMembers(collection:Collection){
 if(collection.ordering==="custom")return collection.members;
 const release=(entry:NativeCatalogEntry)=>{
  for(const key of ["premiered","release_date","aired"]){const date=entry.metadata[key];if(typeof date==="string"&&/^\d{4}-\d{2}-\d{2}$/.test(date)&&Number.isFinite(Date.parse(date))&&new Date(date).toISOString().slice(0,10)===date)return date;}
  const raw=entry.metadata.year,year=typeof raw==="number"||typeof raw==="string"?Number(raw):NaN;
  return Number.isInteger(year)&&year>=1&&year<=9999?`${String(year).padStart(4,"0")}-12-31`:"9999-12-31";
 };
 const title=(entry:NativeCatalogEntry)=>typeof entry.metadata.sorttitle==="string"&&entry.metadata.sorttitle.trim()?entry.metadata.sorttitle.toLowerCase():entry.title.toLowerCase();
 const compare=(a:string,b:string)=>a<b?-1:a>b?1:0;
 return [...collection.members].sort((a,b)=>(collection.ordering==="release"?compare(release(a.entry),release(b.entry)):0)||compare(title(a.entry),title(b.entry))||compare(a.item_id,b.item_id)||compare(a.library_id,b.library_id));
}
