import type {PlaybackInfo,PlaybackTrack} from "../types";
import {normalizeLanguage} from "./playback";

export type NativeAudioTrack={id?:string;language?:string;label?:string;enabled:boolean};
export type NativeAudioList={length:number;[index:number]:NativeAudioTrack;item?:(index:number)=>NativeAudioTrack|null};

export function nativeAudioTracks(video:HTMLVideoElement):NativeAudioList|null {
  try {
    const list=(video as HTMLVideoElement&{audioTracks?:NativeAudioList}).audioTracks;
    return list&&Number.isInteger(list.length)&&list.length>=0&&list.length<=128?list:null;
  }catch{return null;}
}
export function defaultAudioIndex(info:PlaybackInfo):number|null {
  const tracks=info.tracks.filter(track=>track.kind==="audio");
  return (tracks.find(track=>track.default)??tracks[0])?.index??null;
}
const language=(value?:string|null)=>{const normalized=normalizeLanguage(value);return normalized&&normalized!=="und"?normalized:"";};
const label=(value?:string|null)=>(value??"").trim().toLowerCase();
function labels(track:PlaybackTrack):string[] {
  const known=[track.title,track.language,language(track.language)].map(label).filter(Boolean),code=language(track.language);
  if(code)for(const locale of ["en",navigator.language||"en"]){try{known.push(label(new Intl.DisplayNames([locale],{type:"language"}).of(code)));}catch{/* Retain provider labels. */}}
  return known;
}
export function mapNativeAudio(info:PlaybackInfo,list:NativeAudioList|null):Map<number,NativeAudioTrack> {
  const result=new Map<number,NativeAudioTrack>();if(!list)return result;
  const source=info.tracks.filter(track=>track.kind==="audio"),native=Array.from({length:list.length},(_value,index)=>list.item?.(index)??list[index]).filter((track):track is NativeAudioTrack=>!!track&&typeof track.enabled==="boolean");
  const candidates=native.map(track=>{
    const code=language(track.language),name=label(track.label);
    let options=source.filter(sourceTrack=>!code||!language(sourceTrack.language)||code===language(sourceTrack.language));
    if(code){const matching=options.filter(sourceTrack=>code===language(sourceTrack.language));if(matching.length)options=matching;}
    if(name){const matching=options.filter(sourceTrack=>labels(sourceTrack).includes(name));if(matching.length)options=matching;}
    return {track,options};
  });
  const used=new Set<NativeAudioTrack>();let changed=true;
  while(changed){
    changed=false;
    for(const candidate of candidates){
      if(used.has(candidate.track))continue;
      const options=candidate.options.filter(track=>!result.has(track.index));
      if(options.length!==1)continue;
      const sole=options[0];
      if(candidates.filter(other=>!used.has(other.track)&&other.options.filter(track=>!result.has(track.index)).length===1&&other.options.some(track=>track.index===sole.index)).length!==1)continue;
      // Do not infer an unknown track by elimination when the browser omits
      // source tracks. Numeric browser IDs are not FFprobe stream indexes.
      if(!language(candidate.track.language)&&!label(candidate.track.label)&&native.length!==source.length)continue;
      result.set(sole.index,candidate.track);used.add(candidate.track);changed=true;
    }
  }
  return result;
}
export function enableNativeAudio(list:NativeAudioList|null,mapping:Map<number,NativeAudioTrack>,index:number):boolean {
  const selected=mapping.get(index);if(!list||!selected)return false;
  const tracks=Array.from({length:list.length},(_value,position)=>list.item?.(position)??list[position]).filter(Boolean),previous=tracks.map(track=>track.enabled);
  if(!tracks.includes(selected))return false;
  try{
    for(const track of tracks)track.enabled=track===selected;
    if(selected.enabled&&tracks.every(track=>track===selected||!track.enabled))return true;
  }catch{/* Restore the browser's previous audio selection. */}
  for(let position=0;position<tracks.length;position++){try{tracks[position].enabled=previous[position];}catch{/* Some implementations expose read-only flags. */}}
  return false;
}
