import { afterEach,describe, expect, it, vi } from "vitest";
import {defaultPlaybackPreferences, type PlaybackInfo, type WatchState} from "../api/playback";
import {originalAudioSupported,playbackCapabilities, playbackTime, safePlayerReturn, selectTracks} from "./playback";
const info:PlaybackInfo={title:"Episode",duration_seconds:1200,chapters:[],tracks:[{index:1,kind:"audio",codec:"aac",language:"jpn",default:true},{index:2,kind:"audio",codec:"aac",language:"eng"},{index:3,kind:"subtitle",codec:"ass",language:"eng",default:true},{index:4,kind:"subtitle",codec:"ass",language:"eng",forced:true},{index:5,kind:"subtitle",codec:"srt",language:"eng",hearing_impaired:true}]};
const state:WatchState={session_id:null,version:0,position_seconds:200,duration_seconds:1200,watched:false,play_count:0,last_played_at:null,audio_index:null,subtitle_index:null};
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
describe("playback time and navigation",()=>{
 it("formats source time and rejects invalid positions",()=>{expect(playbackTime(3665.9)).toBe("1:01:05");expect(playbackTime(65)).toBe("1:05");expect(playbackTime(-1)).toBe("0:00");expect(playbackTime(NaN)).toBe("0:00");});
 it("permits local return paths and rejects protocol-relative and slash ambiguities",()=>{expect(safePlayerReturn("/media/Anime?q=x")).toBe("/media/Anime?q=x");expect(safePlayerReturn("//external.test")).toBe("/");expect(safePlayerReturn("/\\external.test")).toBe("/");expect(safePlayerReturn("https://external.test")).toBe("/");});
});
describe("track selection",()=>{
 it("preserves valid remembered tracks, including explicit subtitles Off",()=>{expect(selectTracks(info,defaultPlaybackPreferences,{...state,audio_index:2,subtitle_index:-1})).toEqual({audio:2,subtitle:-1});});
 it("ignores stale remembered indices and obeys language preferences when default override is off",()=>{expect(selectTracks(info,{...defaultPlaybackPreferences,prefer_default_audio:false,audio_languages:["en"],subtitle_mode:"forced"},{...state,audio_index:99,subtitle_index:99})).toEqual({audio:2,subtitle:4});});
 it("smart mode uses forced subtitles for understood audio, full subtitles for foreign audio",()=>{
  const prefs={...defaultPlaybackPreferences,audio_languages:["en"],subtitle_languages:["en"],subtitle_mode:"smart" as const};
  expect(selectTracks(info,prefs,{...state,audio_index:2})).toEqual({audio:2,subtitle:4});
  expect(selectTracks(info,prefs,state)).toEqual({audio:1,subtitle:3});
 });
 it("selects hearing impaired subtitles and never forces missing tracks",()=>{expect(selectTracks(info,{...defaultPlaybackPreferences,subtitle_mode:"hearing_impaired",subtitle_languages:["en"]},state)).toEqual({audio:1,subtitle:5});expect(selectTracks({...info,tracks:[]},defaultPlaybackPreferences,state)).toEqual({audio:null,subtitle:-1});});
 it("honors ordered language preferences instead of file track order",()=>{
  const ordered={...info,tracks:[{index:1,kind:"audio",codec:"aac",language:"eng"},{index:2,kind:"audio",codec:"aac",language:"jpn"},{index:3,kind:"subtitle",codec:"srt",language:"eng"},{index:4,kind:"subtitle",codec:"srt",language:"jpn"}]};
  expect(selectTracks(ordered,{...defaultPlaybackPreferences,prefer_default_audio:false,audio_languages:["ja","en"],subtitle_languages:["ja","en"],subtitle_mode:"always"},state)).toEqual({audio:2,subtitle:4});
 });
});
describe("native original-file capabilities",()=>{
 it("reports original codecs and MKV for Chromium without probing MSE or a segmented stream",async()=>{
  vi.stubGlobal("navigator",{userAgent:"Mozilla/5.0 Chrome/145.0",language:"en"});const mse=vi.fn(()=>true);vi.stubGlobal("MediaSource",{isTypeSupported:mse});
  const video={canPlayType:vi.fn((type:string)=>/matroska|video\/mkv/.test(type)?"":"probably"),audioTracks:{length:0}} as unknown as HTMLVideoElement;
  const caps=await playbackCapabilities({...info,container:"mkv",tracks:[{index:0,kind:"video",codec:"hevc",profile:"Main 10",bit_depth:10,pixel_format:"yuv420p10le"}]},video);
  expect(caps.source_video_supported).toBe(true);expect(caps.containers).toContain("mkv");expect(caps.audio_codecs).toContain("opus");expect(caps.native_audio_tracks).toBe(true);expect(mse).not.toHaveBeenCalled();expect(Object.keys(caps).sort()).toEqual(["source_video_supported","native_audio_tracks","video_codecs","audio_codecs","containers"].sort());
 });
 it("does not claim MKV or native track selection for unknown browser profiles",async()=>{
  vi.stubGlobal("navigator",{userAgent:"Mozilla/5.0 Firefox/145.0",language:"en"});const video={canPlayType:vi.fn((type:string)=>/matroska|video\/mkv/.test(type)?"":"probably")} as unknown as HTMLVideoElement;
  const caps=await playbackCapabilities(info,video);expect(caps.containers).not.toContain("mkv");expect(caps.native_audio_tracks).toBe(false);
 });
 it("accepts truthful Matroska MIME support and excludes Opera TV from the Chromium shortcut",async()=>{
  vi.stubGlobal("navigator",{userAgent:"Opera TV Chrome/145.0",language:"en",userAgentData:{brands:[{brand:"Chromium"}]}});const video={canPlayType:vi.fn((type:string)=>/matroska|video\/mkv/.test(type)?"":"probably")} as unknown as HTMLVideoElement;
  expect((await playbackCapabilities(info,video)).containers).not.toContain("mkv");vi.stubGlobal("navigator",{userAgent:"Unknown",language:"en"});vi.mocked(video.canPlayType).mockReturnValue("probably");expect((await playbackCapabilities(info,video)).containers).toContain("mkv");
 });
 it.each([
  {codec:"hevc",profile:"Main 12",bit_depth:12,pixel_format:"yuv420p12le"},
  {codec:"hevc",profile:"Rext",bit_depth:10,pixel_format:"yuv420p10le"},
  {codec:"hevc",profile:"Main 10",bit_depth:10,pixel_format:"yuv444p10le"},
  {codec:"av1",profile:"Professional",bit_depth:12,pixel_format:"yuv420p12le"},
  {codec:"av1",profile:"High",bit_depth:10,pixel_format:"yuv444p10le"},
 ])("does not misidentify $codec $profile $pixel_format as a compatible Main source",async source=>{
  const caps=await playbackCapabilities({...info,tracks:[{index:0,kind:"video",...source}]},{canPlayType:()=>"probably"} as unknown as HTMLVideoElement);expect(caps.source_video_supported).toBe(false);expect(caps.video_codecs).not.toContain(source.codec);
 });
 it("tests the actual High10 profile and obeys negative native decoding evidence",async()=>{
  const video={canPlayType:vi.fn((type:string)=>type.includes("6E0028")?"":"probably")} as unknown as HTMLVideoElement;const source={...info,tracks:[{index:0,kind:"video",codec:"h264",profile:"High 10",bit_depth:10}]};const caps=await playbackCapabilities(source,video);expect(caps.source_video_supported).toBe(false);expect(caps.video_codecs).not.toContain("h264");
  vi.stubGlobal("navigator",{userAgent:"Chrome/145.0",mediaCapabilities:{decodingInfo:vi.fn().mockResolvedValue({supported:false})}});vi.mocked(video.canPlayType).mockReturnValue("probably");expect((await playbackCapabilities(source,video)).source_video_supported).toBe(false);
 });
 it("checks AAC profiles per original track and never claims TrueHD/DTS/PCM from generic audio support",()=>{
  const video={canPlayType:vi.fn((type:string)=>type.includes("40.5")?"":"probably")} as unknown as HTMLVideoElement;
  expect(originalAudioSupported({index:1,kind:"audio",codec:"aac",profile:"LC"},video)).toBe(true);expect(originalAudioSupported({index:2,kind:"audio",codec:"aac",profile:"HE-AAC"},video)).toBe(false);
  for(const codec of ["truehd","dts","pcm_s24le"])expect(originalAudioSupported({index:1,kind:"audio",codec},video)).toBe(false);
 });
});
