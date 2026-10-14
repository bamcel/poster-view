import type {NativeCatalogEntry} from "../api/nativeLibraries";
// A scan or title edit must not change artwork identity. Local file changes
// carry a dedicated token; managed replacements have a new artwork path.
export function nativeArtworkVersion(entry:NativeCatalogEntry,kind:string):string {
 const artwork=entry.artwork.find(image=>image.kind===kind);
 return JSON.stringify([artwork?.path??"",artwork?.source??"",entry.metadata._artwork_cache_revision??null]);
}
