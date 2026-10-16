import {describe,it,expect} from "vitest";
import type {NativeCatalogEntry} from "../../api/nativeLibraries";
import type {Collection,CollectionMember} from "./client";
import {groupLibraryTitles,orderedMembers,uniqueMembers} from "./grouping";
const entry=(id:string,year=2000):NativeCatalogEntry=>({id,title:id,path:id,kind:"movie",parent_path:null,metadata:{year},artwork:[],files:[],nfo_path:null,available:true,revision:1});
const member=(id:string,library="movies",year=2000):CollectionMember=>({library_id:library,library_name:library,item_id:id,entry:entry(id,year)});
const collection=(members:CollectionMember[]):Collection=>({id:"saga",title:"Saga",overview:"",ordering:"release",revision:1,created_at:"",updated_at:"",members});
describe("collection presentation",()=>{
 it("groups only two accessible titles from this library and retains unrelated titles",()=>{const data=collection([member("a"),member("b"),member("x","shows")]);const result=groupLibraryTitles([entry("a"),entry("b"),entry("c")],[data],"movies");expect(result.collections).toEqual([{...data,members:data.members.slice(0,2)}]);expect(result.entries.map(item=>item.id)).toEqual(["c"]);});
 it("does not hide a singleton, missing or unavailable title",()=>{const data=collection([member("a"),member("b"),member("c")]);const entries=[entry("a"),{...entry("b"),available:false},{...entry("c"),metadata:{missing:true}}];expect(groupLibraryTitles(entries,[data],"movies")).toEqual({collections:[],entries});});
 it("counts unique members rather than duplicate membership",()=>{const entries=[entry("a")];expect(groupLibraryTitles(entries,[collection([member("a"),member("a")])],"movies").collections).toEqual([]);expect(uniqueMembers([member("a"),member("a"),member("a","shows")])).toHaveLength(2);});
 it("sorts release, title and custom without mutating server data",()=>{const data=collection([member("z","movies",1990),member("a","movies",2020)]);expect(orderedMembers(data).map(item=>item.item_id)).toEqual(["z","a"]);expect(orderedMembers({...data,ordering:"title"}).map(item=>item.item_id)).toEqual(["a","z"]);expect(orderedMembers({...data,ordering:"custom"})).toEqual(data.members);expect(data.members[0].item_id).toBe("z");});
});

it("keeps unknown dates last, honors exact dates before year-only dates and respects sort titles",()=>{
 const a=member("a"),b=member("b"),c=member("c");a.entry.metadata={year:2020,premiered:""};b.entry.metadata={year:2020,release_date:"2020-01-01"};c.entry.metadata={year:"bad",premiered:"2020-02-31"};
 expect(orderedMembers(collection([a,c,b])).map(item=>item.item_id)).toEqual(["b","a","c"]);
 a.entry.metadata.sorttitle="Z";b.entry.metadata.sorttitle="A";expect(orderedMembers({...collection([a,b]),ordering:"title"}).map(item=>item.item_id)).toEqual(["b","a"]);
});
