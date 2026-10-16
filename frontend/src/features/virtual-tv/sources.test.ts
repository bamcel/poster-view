import {expect,it} from "vitest";
import type {NativeCatalogEntry} from "../../api/nativeLibraries";
import {isChannelSource} from "./sources";
const entry=(path:string,kind:string,title=path.split("/").at(-1)!)=>({path,kind,title,metadata:{}} as NativeCatalogEntry);
it("keeps series and standalone movies while hiding misclassified season folders and trailers",()=>{
 for(const path of ["Anime/Show/Specials","Anime/Show/Season 1","Anime/Show/S00","Anime/Show/Extras"])expect(isChannelSource(entry(path,"series"))).toBe(false);
 for(const path of ["Anime/Show/Trailers/Trailer 1.mp4","Anime/Show/Specials/Bonus.mp4","Movies/Film/Film-trailer.mkv"])expect(isChannelSource(entry(path,"movie"))).toBe(false);
 expect(isChannelSource(entry("Anime/Show","series"))).toBe(true);
 expect(isChannelSource(entry("Movies/Trailer Park Boys/Trailer Park Boys.mkv","movie","Trailer Park Boys"))).toBe(true);
 expect(isChannelSource(entry("Movies/Specials/Specials.mkv","movie","Specials"))).toBe(false);
});
