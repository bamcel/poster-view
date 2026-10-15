import type {PlaybackInfo, PlaybackPreferences, PlaybackTrack, WatchState} from "../types";
import {normalizeLanguage} from "./playback";

export interface TrackPreference {
  language:string;
  title?:string;
  codec?:string;
  channels?:number;
  forced?:boolean;
  hearing_impaired?:boolean;
}
export interface SeriesTrackPreferences {
  audio?:TrackPreference|null;
  subtitle?:TrackPreference|null;
  subtitles_off?:boolean;
}
type Selection={audio:number|null;subtitle:number};
const normalizedTitle=(value?:string|null)=>value?.toLowerCase().replace(/[^\p{L}\p{N}]+/gu," ").trim()??"";
const semantics=(value?:string|null)=>({
  commentary:/\b(commentary|comments?|director(?:s)? commentary)\b/i.test(value??""),
  description:/\b(audio description|descriptive audio|described audio|visually impaired)\b/i.test(value??""),
});
const limitedSubtitle=(value?:string|null)=>/\b(signs?|songs?|forced|foreign (?:parts?|dialogue|dialog))\b/i.test(value??"");
const knownLanguage=(value?:string|null)=>{
  const language=normalizeLanguage(value?.trim().replaceAll("_","-"));
  return language&&/^[a-z0-9-]{1,24}$/.test(language)&&!['und','unknown','zxx','mul'].includes(language)?language:null;
};
const boundedLabel=(value:string|null|undefined,maximumBytes:number)=>{
  let result="",bytes=0;
  for(const character of (value??"").trim()){
    if(/[\u0000-\u001f\u007f-\u009f]/u.test(character))continue;
    const code=character.codePointAt(0)!,size=code<=0x7f?1:code<=0x7ff?2:code<=0xffff?3:4;
    if(bytes+size>maximumBytes)break;
    result+=character;bytes+=size;
  }
  return result||undefined;
};

/** Describe the selected content, never its position in this episode's stream list. */
export function descriptorFromPlaybackTrack(track:PlaybackTrack):TrackPreference {
  const channels=track.channels;
  return {language:knownLanguage(track.language)??"und",title:boundedLabel(track.title,256),codec:boundedLabel(track.codec,64),
    channels:channels!=null&&Number.isInteger(channels)&&channels>0&&channels<=64?channels:undefined,
    forced:!!track.forced,hearing_impaired:!!track.hearing_impaired};
}

function matchTrack(tracks:PlaybackTrack[],preference:TrackPreference|undefined|null):PlaybackTrack|undefined {
  const language=knownLanguage(preference?.language);
  if(!preference||!language)return undefined;
  const desired=semantics(preference.title),title=normalizedTitle(preference.title);
  const candidates=tracks.filter(track=>{
    const actual=semantics(track.title);
    return knownLanguage(track.language)===language&&!!track.forced===!!preference.forced&&
      actual.commentary===desired.commentary&&actual.description===desired.description&&
      (track.kind!=="subtitle"||limitedSubtitle(track.title)===limitedSubtitle(preference.title));
  });
  const score=(track:PlaybackTrack)=>
    (Boolean(track.hearing_impaired)===Boolean(preference.hearing_impaired)?100:0)+
    (title&&normalizedTitle(track.title)===title?30:0)+
    (preference.channels!=null&&track.channels===preference.channels?10:0)+
    (preference.codec&&track.codec.toLowerCase()===preference.codec.toLowerCase()?5:0)+
    (track.default?1:0);
  return candidates.reduce<PlaybackTrack|undefined>((best,track)=>!best||score(track)>score(best)?track:best,undefined);
}

/** Valid per-item selections win; unavailable series choices retain ordinary preference selection. */
export function chooseSeriesTracks(info:PlaybackInfo,preferences:PlaybackPreferences,state:WatchState,
  series:SeriesTrackPreferences|undefined|null,baseSelection:Selection):Selection {
  if(!series||preferences.remember_series_tracks===false)return baseSelection;
  const result={...baseSelection};
  const audio=info.tracks.filter(track=>track.kind==="audio"),subtitles=info.tracks.filter(track=>track.kind==="subtitle");
  if(!preferences.remember_audio||!audio.some(track=>track.index===state.audio_index)){
    result.audio=matchTrack(audio,series.audio)?.index??result.audio;
  }
  if(!preferences.remember_subtitles||(state.subtitle_index!==-1&&!subtitles.some(track=>track.index===state.subtitle_index))){
    result.subtitle=series.subtitles_off?-1:matchTrack(subtitles,series.subtitle)?.index??result.subtitle;
  }
  return result;
}
