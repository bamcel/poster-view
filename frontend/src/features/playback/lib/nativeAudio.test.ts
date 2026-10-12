import {describe,expect,it} from "vitest";
import type {PlaybackInfo} from "../types";
import {defaultAudioIndex,enableNativeAudio,mapNativeAudio,type NativeAudioList} from "./nativeAudio";
const info:PlaybackInfo={title:"Episode",duration_seconds:1200,chapters:[],tracks:[{index:2,kind:"audio",codec:"opus",language:"ja",title:"Japanese"},{index:3,kind:"audio",codec:"opus",language:"en",title:"English",default:true}]};
const list=(tracks:NativeAudioList[number][])=>Object.assign({length:tracks.length},tracks) as NativeAudioList;
describe("native audio selection",()=>{
  it("maps unique languages independently of browser order and enables exactly the selected track",()=>{
    const english={id:"container-12",language:"eng",label:"English",enabled:true},japanese={id:"container-40",language:"jpn",label:"Japanese",enabled:false},native=list([english,japanese]),mapping=mapNativeAudio(info,native);
    expect(defaultAudioIndex(info)).toBe(3);expect(mapping.get(2)).toBe(japanese);expect(enableNativeAudio(native,mapping,2)).toBe(true);expect(japanese.enabled).toBe(true);expect(english.enabled).toBe(false);
  });
  it("rejects ambiguous tracks even when numeric browser IDs resemble stream indexes",()=>{
    const sameLanguage={...info,tracks:info.tracks.map(track=>({...track,language:"en",title:""}))};
    expect(mapNativeAudio(sameLanguage,list([{id:"2",enabled:true},{id:"3",enabled:false}])).size).toBe(0);
  });
  it("uses known labels or a single remaining track only when the track count is complete",()=>{
    const native=list([{label:"Japanese",enabled:false},{enabled:true}]);expect(mapNativeAudio(info,native).size).toBe(2);
    expect(mapNativeAudio(info,list([{enabled:true}])).size).toBe(0);
    expect(mapNativeAudio(info,list([{language:"ja",enabled:true}])).has(3)).toBe(false);
  });
  it("reports failed flag writes rather than pretending a track changed",()=>{
    const english={language:"en",enabled:true},japanese={language:"ja",enabled:false};Object.defineProperty(japanese,"enabled",{value:false,writable:false});
    const native=list([english,japanese]);expect(enableNativeAudio(native,mapNativeAudio(info,native),2)).toBe(false);expect(english.enabled).toBe(true);expect(japanese.enabled).toBe(false);
  });
  it("does not apply mappings retained from an earlier media source",()=>{
    const old=list([{language:"ja",enabled:true},{language:"en",enabled:false}]),mapping=mapNativeAudio(info,old);
    expect(enableNativeAudio(list([]),mapping,2)).toBe(false);
    expect(enableNativeAudio(list([{language:"ja",enabled:false},{language:"en",enabled:true}]),mapping,2)).toBe(false);
  });
});
