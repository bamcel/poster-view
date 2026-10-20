import type { NativeCatalogEntry } from "../api/nativeLibraries";
import {normalizeLanguage} from "../features/playback/lib/playback";
import type {PlaybackPreferences} from "../features/playback/types";
import {mediaSourceLabel} from "./mediaSources";

export interface MediaFormats { source?:string; quality?: string; hdr?: string; audio?: string; dualAudio?: boolean }
type Stream = Record<string, unknown>;

function number(value: unknown): number {
  const parsed = typeof value === "number" || typeof value === "string" ? Number(value) : 0;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function dimensions(stream: Stream): [number, number] {
  const width = number(stream.width), height = number(stream.height);
  return [Math.max(width, height), Math.min(width, height)];
}

function quality(stream: Stream): string | undefined {
  const [long, short] = dimensions(stream);
  if (!long || !short) return undefined;
  if (long >= 7000 || short >= 4000) return "8K";
  if (long >= 3500 || short >= 2000) return "UHD 4K";
  if (long >= 1800 || short >= 1000) return "Full HD";
  if (long >= 1200 || short >= 700) return "HD";
  return "SD";
}

// Read probe attributes only: filenames and catalog titles are not evidence of a format.
function markers(stream: Stream): string {
  return JSON.stringify([stream.profile, stream.tags, stream.side_data_list, stream.side_data]).toLowerCase();
}

function hdr(stream: Stream): string | undefined {
  const marker = markers(stream);
  if (/dolby[ ._-]*vision|dovi|dv_profile/.test(marker)) return "Dolby Vision";
  const transfer = String(stream.color_transfer ?? "").toLowerCase();
  if (transfer === "arib-std-b67") return "HLG";
  if (transfer === "smpte2084" && String(stream.color_primaries ?? "").toLowerCase() === "bt2020") return "HDR10";
  return undefined;
}

function audio(stream: Stream): { label?: string; rank: number } {
  const marker = markers(stream);
  if (/\batmos\b|\bjoc\b/.test(marker)) return { label: "Dolby Atmos", rank: 100 };
  if (/\bdts[ :_-]*x\b/.test(marker)) return { label: "DTS:X", rank: 99 };
  const channels = number(stream.channels);
  const layout = String(stream.channel_layout ?? "").toLowerCase();
  if (channels === 8 || /^7\.1(?:\(|$)/.test(layout)) return { label: "7.1 Surround", rank: 8 };
  if (channels === 6 || /^5\.1(?:\(|$)/.test(layout)) return { label: "5.1 Surround", rank: 6 };
  if (channels === 2 || layout === "stereo") return { label: "Stereo", rank: 2 };
  return { rank: channels };
}

/** Describe one actual file version, never a combination of unrelated versions. */
export function mediaFormats(entry: NativeCatalogEntry,preferences?:Pick<PlaybackPreferences,"audio_languages"|"prefer_default_audio">): MediaFormats {
  const versions = entry.files.map(file => {
    const streams = Array.isArray(file.media_info?.streams) ? file.media_info.streams : [];
    const videos = streams.filter(stream => stream.codec_type === "video" && !(stream.disposition as Record<string, unknown> | undefined)?.attached_pic);
    const video = videos.sort((a, b) => {
      const [aw, ah] = dimensions(a), [bw, bh] = dimensions(b);
      return bw * bh - aw * ah;
    })[0];
    const [width, height] = video ? dimensions(video) : [0, 0];
    return { streams, video, path:file.path, area: width * height };
  }).sort((a, b) => b.area - a.area);
  const selected = versions[0];
  if (!selected) return {};
  const source=entry.kind==="episode"?mediaSourceLabel(entry.metadata._inherited_media_source):mediaSourceLabel((entry.metadata.media_sources as Record<string,unknown>|undefined)?.[selected.path]);
  const audioStreams=selected.streams.filter(stream=>stream.codec_type==="audio");
  const languageOf=(stream:Stream)=>{
    const value=(stream.tags as Record<string,unknown>|undefined)?.language??stream.language;
    return typeof value==="string"?normalizeLanguage(value.trim().replaceAll("_","-")):"";
  };
  const defaultAudio=audioStreams.find(stream=>!!(stream.disposition as Record<string,unknown>|undefined)?.default);
  const preferredAudio=preferences?.audio_languages.map(language=>audioStreams.find(stream=>languageOf(stream)===normalizeLanguage(language))).find(Boolean);
  const chosenAudio=preferences?((preferences.prefer_default_audio?defaultAudio:undefined)??preferredAudio??defaultAudio??audioStreams[0]):undefined;
  const bestAudio = preferences?(chosenAudio?audio(chosenAudio):undefined):audioStreams.map(audio).sort((a, b) => b.rank - a.rank)[0];
  const languages=new Set(audioStreams.flatMap(stream=>{
    const raw=(stream.tags as Record<string,unknown>|undefined)?.language??stream.language;
    if(typeof raw!=="string")return [];
    const language=normalizeLanguage(raw.trim().replaceAll("_","-"));
    return /^[a-z]{2,3}$/.test(language)&&!["und","zxx","mul"].includes(language)?[language]:[];
  }));
  return {
    ...(source?{source}:{}),
    ...(selected.video && quality(selected.video) ? { quality: quality(selected.video) } : {}),
    ...(selected.video && hdr(selected.video) ? { hdr: hdr(selected.video) } : {}),
    ...(bestAudio?.label ? { audio: bestAudio.label } : {}),
    ...(languages.size>1?{dualAudio:true}:{}),
  };
}
