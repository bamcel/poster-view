import type {NativeCatalogEntry} from "../../api/nativeLibraries";

const auxiliary=new Set(["extras","extra","trailers","trailer","featurettes","behind the scenes","deleted scenes","interviews","backdrops","backdrop"]);
const seasonFolder=/^(?:(?:.+?)[ ._-]+)?(?:season|s)[ ._-]*\d{1,3}$/i;
export function isChannelSource(entry:NativeCatalogEntry):boolean {
 const parts=entry.path.replaceAll("\\","/").split("/");
 if(parts.some(part=>auxiliary.has(part.toLowerCase())))return false;
 const leaf=parts.at(-1)??"";
 if(entry.kind==="series")return !/^(specials?|season[ ._-]*0)$/i.test(leaf)&&!seasonFolder.test(leaf);
 if(entry.kind!=="movie")return false;
 if(parts.slice(0,-1).some(part=>/^specials?$/i.test(part)||seasonFolder.test(part)))return false;
 return !/(?:^|[ ._-])trailer(?:[ ._-]*\d+)?$/i.test(leaf.replace(/\.[^.]+$/,""))
   && !/(?:^|[ ._-])trailer(?:[ ._-]*\d+)?$/i.test(entry.title)
   && !entry.metadata.extra_type&&!entry.metadata.extratype;
}
