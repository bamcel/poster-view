import { afterEach,describe, expect, it, vi } from "vitest";
import {defaultPlaybackPreferences, type PlaybackInfo, type WatchState} from "../api/playback";
import {canRemuxAudio,playbackCapabilities, playbackTime, safePlayerReturn, selectTracks} from "./playback";
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
describe("codec capabilities",()=>{
 it.each([
  {codec:"hevc",profile:"Main 12",bit_depth:12,pixel_format:"yuv420p12le"},
  {codec:"hevc",profile:"Rext",bit_depth:10,pixel_format:"yuv420p10le"},
  {codec:"hevc",profile:"Main 10",bit_depth:10,pixel_format:"yuv444p10le"},
  {codec:"hevc",profile:"Main",pixel_format:"yuv420p12le"},
  {codec:"av1",profile:"Professional",bit_depth:12,pixel_format:"yuv420p12le"},
  {codec:"av1",profile:"High",bit_depth:10,pixel_format:"yuv444p10le"},
 ])("does not claim scoped source/copy compatibility for $codec $profile $pixel_format",async source=>{
  vi.stubGlobal("MediaSource",{isTypeSupported:vi.fn(()=>true)});const caps=await playbackCapabilities({...info,remux_allowed:true,tracks:[{index:0,kind:"video",...source},{index:1,kind:"audio",codec:"aac"}]},{canPlayType:()=>"probably"} as unknown as HTMLVideoElement);
  expect(caps.source_video_supported).toBe(false);expect(caps.hls_video_codecs).not.toContain(source.codec);expect(caps.hls_aac_supported).toBe(false);expect(caps.video_codecs).toContain(source.codec);expect(caps.video_codecs).toContain("h264");
 });
 it("verifies AAC-LC output independently of unsupported lossless and HE-AAC source tracks",async()=>{
  vi.stubGlobal("MediaSource",{isTypeSupported:vi.fn((mime:string)=>mime.includes("hvc1.2.4.L153.B0")&&!mime.includes("40.5"))});
  const source:PlaybackInfo={...info,remux_allowed:true,tracks:[{index:0,kind:"video",codec:"hevc",bit_depth:10},{index:1,kind:"audio",codec:"truehd"},{index:2,kind:"audio",codec:"aac",profile:"HE-AAC"}]};
  const caps=await playbackCapabilities(source,{canPlayType:()=>"probably"} as unknown as HTMLVideoElement);expect(caps.hls_aac_supported).toBe(true);expect(caps.hls_audio_track_indexes).not.toContain(1);expect(caps.hls_audio_track_indexes).not.toContain(2);expect(canRemuxAudio(source,caps,2)).toBe(false);
 });
 it("does not permit audio-only AAC output with an unsupported source video profile",async()=>{
  vi.stubGlobal("MediaSource",{isTypeSupported:vi.fn((mime:string)=>!mime.includes("hvc1.2.4"))});const source={...info,tracks:[{index:0,kind:"video",codec:"hevc",bit_depth:10},{index:1,kind:"audio",codec:"dts",profile:"DTS-HD MA"}]};
  expect((await playbackCapabilities(source,{canPlayType:()=>"probably"} as unknown as HTMLVideoElement)).hls_aac_supported).toBe(false);
 });
 it("probes Main 10 HEVC and both Opus audio tracks together for lossless fMP4 playback",async()=>{
  const supported=vi.fn((mime:string)=>mime.includes("hvc1.2.4.L153.B0")&&!mime.includes("mp4a"));vi.stubGlobal("MediaSource",{isTypeSupported:supported});
  const source:PlaybackInfo={...info,remux_allowed:true,tracks:[{index:0,kind:"video",codec:"hevc",bit_depth:10},{index:1,kind:"audio",codec:"opus",language:"ja"},{index:2,kind:"audio",codec:"opus",language:"en"}]};
  const video={canPlayType:vi.fn(()=>"probably")} as unknown as HTMLVideoElement;
  const caps=await playbackCapabilities(source,video);
  expect(supported).toHaveBeenCalledWith('video/mp4; codecs="hvc1.2.4.L153.B0,opus"');expect(caps.hls_video_codecs).toContain("hevc");expect(caps.hls_audio_codecs).toContain("opus");expect(caps.hls_audio_codecs).not.toContain("aac");expect(canRemuxAudio(source,caps,2)).toBe(true);
 });
 it("does not infer copy support from direct Opus, separate audio support, or an 8-bit video profile",async()=>{
  vi.stubGlobal("MediaSource",{isTypeSupported:vi.fn((mime:string)=>mime==='audio/mp4; codecs="opus"'||mime==='video/mp4; codecs="hvc1.1.6.L123.B0"')});
  const source:PlaybackInfo={...info,remux_allowed:true,tracks:[{index:0,kind:"video",codec:"hevc",bit_depth:10},{index:1,kind:"audio",codec:"opus"}]};
  const video={canPlayType:vi.fn(()=>"probably")} as unknown as HTMLVideoElement;
  const caps=await playbackCapabilities(source,video);expect(caps.audio_codecs).toContain("opus");expect(caps.hls_video_codecs).not.toContain("hevc");expect(caps.hls_audio_codecs).not.toContain("opus");expect(canRemuxAudio(source,caps,1)).toBe(false);
 });
 it("uses native HLS codec answers only when no usable MSE path exists",async()=>{
  vi.stubGlobal("MediaSource",{isTypeSupported:vi.fn(()=>false)});
  const source:PlaybackInfo={...info,remux_allowed:true,tracks:[{index:0,kind:"video",codec:"h264"},{index:1,kind:"audio",codec:"aac"}]};
  const video={canPlayType:vi.fn(()=>"probably")} as unknown as HTMLVideoElement;
  expect(canRemuxAudio(source,await playbackCapabilities(source,video,true),1)).toBe(false);
  expect(canRemuxAudio(source,await playbackCapabilities(source,video,false),1)).toBe(true);
  vi.mocked(video.canPlayType).mockImplementation(type=>type.includes("mpegurl")||type.includes("mpegURL")?"":"probably");
  expect(canRemuxAudio(source,await playbackCapabilities(source,video,false),1)).toBe(false);
 });
 it("keeps supported AAC-LC selectable when another AAC profile is unsupported",async()=>{
  vi.stubGlobal("MediaSource",{isTypeSupported:vi.fn((mime:string)=>!mime.includes("40.5"))});
  const source:PlaybackInfo={...info,remux_allowed:true,tracks:[{index:0,kind:"video",codec:"h264"},{index:1,kind:"audio",codec:"aac"},{index:2,kind:"audio",codec:"aac",profile:"HE-AAC"}]};
  const caps=await playbackCapabilities(source,{canPlayType:()=>"probably"} as unknown as HTMLVideoElement);expect(caps.hls_audio_codecs).toContain("aac");expect(caps.hls_audio_track_indexes).toEqual([1]);expect(canRemuxAudio(source,caps,1)).toBe(true);expect(canRemuxAudio(source,caps,2)).toBe(false);expect(canRemuxAudio({...source,remux_allowed:undefined},caps,1)).toBe(false);
 });
 it("does not offer alternate-audio remux for video codecs outside the server copy contract",async()=>{
  vi.stubGlobal("MediaSource",{isTypeSupported:()=>true});
  const source:PlaybackInfo={...info,remux_allowed:true,tracks:[{index:0,kind:"video",codec:"vp9"},{index:1,kind:"audio",codec:"opus"}]};
  const caps=await playbackCapabilities(source,{canPlayType:()=>"probably"} as unknown as HTMLVideoElement);
  expect(caps.hls_video_codecs).not.toContain("vp9");expect(canRemuxAudio(source,caps,1)).toBe(false);
 });
 it("reports compatible MKV and Opus for a Chromium client without requiring a truthful Matroska MIME answer",async()=>{
  vi.stubGlobal("navigator",{userAgent:"Mozilla/5.0 Chrome/145.0.0.0",language:"en"});
  const video={canPlayType:vi.fn((type:string)=>/matroska|video\/mkv/.test(type)?"":"probably"),audioTracks:{length:0}} as unknown as HTMLVideoElement;
  const capabilities=await playbackCapabilities({...info,container:"mkv",tracks:[{index:0,kind:"video",codec:"hevc",profile:"Main 10",bit_depth:10}]},video);
  expect(capabilities.containers).toContain("mkv");expect(capabilities.audio_codecs).toContain("opus");expect(capabilities.video_codecs).toContain("hevc");expect(capabilities.native_audio_tracks).toBe(true);
 });
 it("does not claim MKV or native audio selection for unknown browsers",async()=>{
  vi.stubGlobal("navigator",{userAgent:"Mozilla/5.0 Firefox/145.0",language:"en"});
  const video={canPlayType:vi.fn((type:string)=>/matroska|video\/mkv/.test(type)?"":"probably")} as unknown as HTMLVideoElement;
  const capabilities=await playbackCapabilities(info,video);expect(capabilities.containers).not.toContain("mkv");expect(capabilities.native_audio_tracks).toBe(false);
 });
 it("accepts truthful Matroska MIME support and excludes Opera TV from the Chromium profile shortcut",async()=>{
  vi.stubGlobal("navigator",{userAgent:"Opera TV Chrome/145.0",language:"en",userAgentData:{brands:[{brand:"Chromium"}]}});
  const video={canPlayType:vi.fn((type:string)=>/matroska|video\/mkv/.test(type)?"":"probably")} as unknown as HTMLVideoElement;
  expect((await playbackCapabilities(info,video)).containers).not.toContain("mkv");
  vi.stubGlobal("navigator",{userAgent:"UnknownBrowser",language:"en"});vi.mocked(video.canPlayType).mockReturnValue("probably");
  expect((await playbackCapabilities(info,video)).containers).toContain("mkv");
 });
 it("keeps compatible 8-bit encoder output when the source uses an unsupported 10-bit profile",async()=>{
  const video={canPlayType:vi.fn((type:string)=>type.includes("6E0028")?"":"probably")} as unknown as HTMLVideoElement;
  const capabilities=await playbackCapabilities({...info,tracks:[{index:0,kind:"video",codec:"h264",profile:"High 10",bit_depth:10}]},video);
  expect(capabilities.source_video_supported).toBe(false);expect(capabilities.video_codecs).toContain("h264");
 });
});
