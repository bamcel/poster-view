// Canonical playback/watch wire contracts; coordinate shape changes with Rust models and watch handlers.
import type { NativeCatalogEntry } from "../../api/nativeLibraries";

export interface PlaybackTrack {
  index: number; kind: string; codec: string; language?: string | null; title?: string | null;
  default?: boolean; forced?: boolean; hearing_impaired?: boolean;
  profile?: string | null; width?: number | null; height?: number | null; channels?: number | null;
  bit_depth?: number | null; pixel_format?: string | null; bitrate?: number | null; frame_rate?: number | null;
  subtitle_format?: "ass" | "vtt" | "image"; url?: string | null;
}
export interface PlaybackInfo {
  title: string; series_title?: string | null; season?: number | null; episode?: number | null;
  poster_url?: string | null; overview?: string | null; container?: string; duration_seconds: number;
  tracks: PlaybackTrack[]; chapters: {title: string; start_seconds: number}[];
  fonts?: { index: number; url: string; name: string }[];
  next?: { library_id: string; item_id: string; title: string } | null;
}
export interface PlaybackSession {
  id: string; method: "direct" | "remux" | "audio_transcode" | "transcode"; reason: string;
  url: string; mime: string; offset_seconds: number; duration_seconds: number; encoder?: string | null;
}
export interface PlaybackRequest {
  position_seconds: number; audio_index: number | null; subtitle_index: number | null;
  max_height: number; max_bitrate: number; video_codecs: string[]; audio_codecs: string[]; containers: string[];
  force_transcode?: boolean; preferred_encoder?: string; subtitle_burn_index?: number | null;
}
export interface WatchState {
  position_seconds:number; duration_seconds:number; watched:boolean; play_count:number;
  last_played_at:string|null; audio_index:number|null; subtitle_index:number|null;
  session_id:string|null; version:number;
}
export interface PlaybackPreferences {
  audio_languages: string[]; subtitle_languages: string[]; prefer_default_audio: boolean;
  remember_audio: boolean; remember_subtitles: boolean;
  subtitle_mode: "default" | "smart" | "forced" | "hearing_impaired" | "always" | "off";
  autoplay_next: boolean; resume_rewind_seconds: number; skip_back_seconds: number;
  skip_forward_seconds: number; still_watching_minutes: number; up_next: boolean; subtitle_size: number;
}
export const defaultPlaybackPreferences: PlaybackPreferences = {
  audio_languages: ["en"], subtitle_languages: ["en"], prefer_default_audio: true, remember_audio: true,
  remember_subtitles: true, subtitle_mode: "default", autoplay_next: true, resume_rewind_seconds: 5,
  skip_back_seconds: 10, skip_forward_seconds: 30, still_watching_minutes: 120, up_next: true, subtitle_size: 100,
};

export interface WatchRules {minimum_percentage:number;maximum_percentage:number;minimum_duration_seconds:number}
export interface ContinueItem {library_id:string;library_name:string;item_id:string;title:string;kind:string;entry:NativeCatalogEntry;state:WatchState}
