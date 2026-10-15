import {expect,it} from "vitest";
import type {NativeCatalogEntry} from "../api/nativeLibraries";
import {compareEpisodeOrder,placedSpecials} from "./episodeOrder";
const episode=(id:string,metadata:Record<string,unknown>,parent_path="Show/Specials")=>({id,path:`${parent_path}/${id}`,kind:"episode",metadata,parent_path,title:id,available:true} as NativeCatalogEntry);
it("orders specials at the start, before an episode, and after the season",()=>{
 const items=[episode("after",{season:0,episode:3,airs_after_season:1}),episode("second",{season:1,episode:2}),episode("before",{season:0,episode:2,airs_before_season:1,airs_before_episode:2}),episode("first",{season:1,episode:1}),episode("start",{season:0,episode:1,airs_before_season:1})];
 expect([...items].sort((a,b)=>compareEpisodeOrder(a,b,true)).map(e=>e.id)).toEqual(["start","first","before","second","after"]);
 expect([...items].sort((a,b)=>compareEpisodeOrder(a,b,false)).map(e=>e.id)).toEqual(["start","before","after","first","second"]);
});
it("adds only placed specials from the same series when enabled",()=>{
 const series={...episode("series",{}),path:"Show",kind:"series"};
 const season={...episode("season",{season:1},"Show"),path:"Show/Season 1",kind:"season"};
 const specials={...episode("specials",{season:0},"Show"),path:"Show/Specials",kind:"season"};
 const before=episode("before",{season:0,episode:1,airs_before_season:1});
 const entries=[season,specials,before,episode("unplaced",{season:0,episode:2}),episode("other",{season:0,airs_before_season:1},"Other/Specials")];
 expect(placedSpecials(entries,season,series,true)).toEqual([before]);
 expect(placedSpecials(entries,season,series,false)).toEqual([]);
});
