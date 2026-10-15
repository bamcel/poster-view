import {describe,expect,it} from "vitest";
import {defaultPlaybackPreferences,type PlaybackInfo,type PlaybackTrack,type WatchState} from "../types";
import {chooseSeriesTracks,descriptorFromPlaybackTrack,type SeriesTrackPreferences} from "./seriesTracks";

const state:WatchState={session_id:null,version:0,position_seconds:0,duration_seconds:1200,watched:false,play_count:0,last_played_at:null,audio_index:null,subtitle_index:null};
const audio=(index:number,language:string,extra:Partial<PlaybackTrack>={}):PlaybackTrack=>({index,kind:"audio",codec:"flac",language,...extra});
const subtitle=(index:number,extra:Partial<PlaybackTrack>={}):PlaybackTrack=>({index,kind:"subtitle",codec:"ass",language:"eng",...extra});
const info=(tracks:PlaybackTrack[]):PlaybackInfo=>({title:"Episode",duration_seconds:1200,chapters:[],tracks});
const series:SeriesTrackPreferences={audio:descriptorFromPlaybackTrack(audio(1,"jpn")),subtitle:descriptorFromPlaybackTrack(subtitle(3))};
const base={audio:2,subtitle:8};
describe("series track preferences",()=>{
  it("bounds metadata by UTF-8 bytes and strips controls before persistence",()=>{
    const descriptor=descriptorFromPlaybackTrack(audio(1,"ja_JP",{title:"\n"+"日".repeat(100)+"\t",codec:"\u0000"+"a".repeat(100),channels:100}));
    expect(descriptor).toMatchObject({language:"ja",title:"日".repeat(85),codec:"a".repeat(64),channels:undefined});
    expect(descriptorFromPlaybackTrack(audio(1,"not valid language")).language).toBe("und");
  });
  it("carries Japanese audio and full English subtitles across reordered stream indexes",()=>{
    expect(chooseSeriesTracks(info([audio(1,"eng"),audio(5,"ja-JP"),subtitle(3,{forced:true}),subtitle(9,{language:"en"})]),defaultPlaybackPreferences,state,series,base)).toEqual({audio:5,subtitle:9});
  });
  it("keeps forced, hearing impaired, and commentary choices distinct",()=>{
    const tracks=[audio(2,"jpn",{title:"Director Commentary",channels:2}),audio(5,"jpn",{channels:6}),subtitle(7,{forced:true}),subtitle(8,{hearing_impaired:true}),subtitle(9)];
    expect(chooseSeriesTracks(info(tracks),defaultPlaybackPreferences,state,series,base)).toEqual({audio:5,subtitle:9});
    expect(chooseSeriesTracks(info(tracks),defaultPlaybackPreferences,state,{audio:descriptorFromPlaybackTrack(tracks[0]),subtitle:descriptorFromPlaybackTrack(tracks[2])},base)).toEqual({audio:2,subtitle:7});
    expect(chooseSeriesTracks(info(tracks),defaultPlaybackPreferences,state,{subtitle:descriptorFromPlaybackTrack(tracks[3])},base).subtitle).toBe(8);
  });
  it("does not substitute commentary, descriptive audio, or forced-only subtitles for ordinary tracks",()=>{
    expect(chooseSeriesTracks(info([audio(5,"jpn",{title:"Audio description"}),audio(6,"jpn",{title:"Commentary"}),subtitle(7,{forced:true})]),defaultPlaybackPreferences,state,series,base)).toEqual(base);
  });
  it("distinguishes unflagged signs and songs from full subtitles even when titles and codecs change",()=>{
    const tracks=info([subtitle(4,{title:"Signs & Songs",codec:"ass"}),subtitle(7,{title:"English dialogue",codec:"srt"})]);
    const full={subtitle:descriptorFromPlaybackTrack(subtitle(3,{title:"English full",codec:"ass"}))};
    expect(chooseSeriesTracks(tracks,defaultPlaybackPreferences,state,full,base).subtitle).toBe(7);
    for(const title of ["Signs & Songs","Forced English","Foreign parts"]){
      const choice={subtitle:descriptorFromPlaybackTrack(subtitle(3,{title}))};
      expect(chooseSeriesTracks(tracks,defaultPlaybackPreferences,state,choice,base).subtitle).toBe(4);
    }
    expect(chooseSeriesTracks(info([audio(5,"jpn",{title:"Songs included"})]),defaultPlaybackPreferences,state,series,base).audio).toBe(5);
  });
  it("prefers matching titles, channel layouts and codecs after language and accessibility semantics",()=>{
    const wanted=descriptorFromPlaybackTrack(audio(1,"jpn",{title:"Original",channels:6,codec:"truehd"}));
    expect(chooseSeriesTracks(info([audio(4,"jpn",{channels:2}),audio(5,"ja",{title:"Original",channels:6,codec:"truehd"}),audio(6,"jpn",{title:"Commentary",channels:6,codec:"truehd"})]),defaultPlaybackPreferences,state,{audio:wanted},base).audio).toBe(5);
  });
  it("retains base selection for absent languages and cannot carry unknown-language tracks",()=>{
    const tracks=info([audio(6,"eng"),subtitle(7,{language:"und"})]);
    expect(chooseSeriesTracks(tracks,defaultPlaybackPreferences,state,series,base)).toEqual(base);
    for(const language of ["und","","unknown","zxx","mul"]){
      expect(chooseSeriesTracks(info([audio(6,language)]),defaultPlaybackPreferences,state,{audio:{language}},base)).toEqual(base);
    }
    expect(descriptorFromPlaybackTrack(audio(1,"und")).language).toBe("und");
  });
  it("preserves valid per-item selections including subtitles Off",()=>{
    const tracks=info([audio(2,"eng"),audio(5,"jpn"),subtitle(8),subtitle(9)]);
    expect(chooseSeriesTracks(tracks,defaultPlaybackPreferences,{...state,audio_index:2,subtitle_index:8},series,base)).toEqual(base);
    expect(chooseSeriesTracks(tracks,defaultPlaybackPreferences,{...state,subtitle_index:-1},series,{...base,subtitle:-1})).toEqual({audio:5,subtitle:-1});
  });
  it("carries explicit series subtitles Off unless this episode has its own selection",()=>{
    const tracks=info([subtitle(8)]);
    expect(chooseSeriesTracks(tracks,defaultPlaybackPreferences,state,{subtitles_off:true},base).subtitle).toBe(-1);
    expect(chooseSeriesTracks(tracks,defaultPlaybackPreferences,{...state,subtitle_index:8},{subtitles_off:true},base).subtitle).toBe(8);
  });
  it("remembers series choices independently from disabled per-episode memory",()=>{
    const tracks=info([audio(5,"jpn"),subtitle(9)]);
    const preferences={...defaultPlaybackPreferences,remember_audio:false,remember_subtitles:false};
    expect(chooseSeriesTracks(tracks,preferences,state,series,base)).toEqual({audio:5,subtitle:9});
    expect(chooseSeriesTracks(tracks,preferences,{...state,audio_index:5,subtitle_index:-1},series,base)).toEqual({audio:5,subtitle:9});
    expect(chooseSeriesTracks(tracks,preferences,{...state,subtitle_index:9},{subtitles_off:true},base).subtitle).toBe(-1);
  });
  it("obeys the series opt-out and absent series settings",()=>{
    const tracks=info([audio(5,"jpn"),subtitle(9)]);
    expect(chooseSeriesTracks(tracks,{...defaultPlaybackPreferences,remember_series_tracks:false},state,series,base)).toEqual(base);
    expect(chooseSeriesTracks(tracks,defaultPlaybackPreferences,state,null,base)).toEqual(base);
  });
});
