import {nativeLibraries, type NativeCatalogEntry} from "../../../api/nativeLibraries";
import {nativeArtworkVersion} from "../../../lib/nativeArtworkCache";

/** Carry already known artwork through navigation while playback metadata loads. */
export function startupArtworkState(libraryId:string, entry:NativeCatalogEntry, itemId=entry.id) {
  const kind=["backdrop","fanart","landscape","thumb","poster"].find(kind=>entry.artwork.some(image=>image.kind===kind));
  const url=kind?`${nativeLibraries.artworkUrl(libraryId,entry.id,kind)}?v=${encodeURIComponent(nativeArtworkVersion(entry,kind))}&still=1`:undefined;
  return {playbackArtwork:{libraryId,itemId,url}};
}

export function startupArtworkUrl(state:unknown,libraryId:string,itemId:string):string|undefined {
  const artwork=(state as ReturnType<typeof startupArtworkState>|null)?.playbackArtwork;
  return artwork?.libraryId===libraryId&&artwork.itemId===itemId&&typeof artwork.url==="string"&&artwork.url.startsWith("/api/native/")?artwork.url:undefined;
}
