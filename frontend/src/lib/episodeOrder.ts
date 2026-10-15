import type {NativeCatalogEntry} from "../api/nativeLibraries";
const positive=(value:unknown)=>typeof value==="number"&&Number.isSafeInteger(value)&&value>0?value:null;
export function specialPlacement(entry:NativeCatalogEntry){
 if(entry.kind!=="episode"||entry.metadata.season!==0)return null;
 const before=positive(entry.metadata.airs_before_season),after=positive(entry.metadata.airs_after_season);
 return before?{season:before,episode:positive(entry.metadata.airs_before_episode)??1,slot:0}:after?{season:after,episode:Number.MAX_SAFE_INTEGER,slot:2}:null;
}
export function compareEpisodeOrder(a:NativeCatalogEntry,b:NativeCatalogEntry,enabled:boolean){
 const key=(entry:NativeCatalogEntry)=>{const placement=enabled?specialPlacement(entry):null;return [placement?.season??Number(entry.metadata.season??0),placement?.episode??Number(entry.metadata.episode??0),placement?.slot??1,Number(entry.metadata.episode??0)];};
 const left=key(a),right=key(b);
 for(let i=0;i<left.length;i++){if(left[i]!==right[i])return left[i]-right[i];}
 return a.path<b.path?-1:a.path>b.path?1:0;
}
export function placedSpecials(entries:NativeCatalogEntry[],season:NativeCatalogEntry,series:NativeCatalogEntry|undefined,enabled:boolean){
 if(!enabled||season.kind!=="season"||!positive(season.metadata.season)||!series)return [];
 const parents=new Set([series.path,...entries.filter(entry=>entry.kind==="season"&&entry.parent_path===series.path).map(entry=>entry.path)]);
 return entries.filter(entry=>entry.available&&entry.parent_path!=null&&parents.has(entry.parent_path)&&specialPlacement(entry)?.season===season.metadata.season);
}
