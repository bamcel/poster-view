import { afterEach,describe, expect, it, vi } from "vitest";
import {defaultPlaybackPreferences, type PlaybackInfo, type WatchState} from "../api/playback";
import {audioDeliveryAllowed,automaticStreamCopyAllowed,losslessAudioAllowed,originalAudioSupported,playbackCapabilities, playbackTime, safePlayerReturn, selectTracks} from "./playback";
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
 it("reports original MKV separately from actual source-profile HLS codec probes",async()=>{
  vi.stubGlobal("navigator",{userAgent:"Mozilla/5.0 Chrome/145.0",language:"en"});const mse=vi.fn(()=>true);vi.stubGlobal("MediaSource",{isTypeSupported:mse});
  const video={canPlayType:vi.fn((type:string)=>/matroska|video\/mkv/.test(type)?"":"probably"),audioTracks:{length:0}} as unknown as HTMLVideoElement;
  const caps=await playbackCapabilities({...info,container:"mkv",tracks:[{index:0,kind:"video",codec:"hevc",profile:"Main 10",bit_depth:10,pixel_format:"yuv420p10le"}]},video);
  expect(caps.source_video_supported).toBe(true);expect(caps.containers).toContain("mkv");expect(caps.audio_codecs).toContain("opus");expect(caps.native_audio_tracks).toBe(true);expect(mse).toHaveBeenCalledWith('video/mp4; codecs="hvc1.2.4.L153.B0"');expect(caps.hls_video_codecs).toContain("hevc");expect(caps.hls_aac_supported).toBe(true);
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
  const caps=await playbackCapabilities({...info,tracks:[{index:0,kind:"video",...source}]},{canPlayType:()=>"probably"} as unknown as HTMLVideoElement);expect(caps.source_video_supported).toBe(false);expect(caps.source_hls_video_supported).toBe(false);expect(caps.video_codecs).toContain("h264");
 });
 it("tests the actual High10 profile and obeys negative native decoding evidence",async()=>{
  const video={canPlayType:vi.fn((type:string)=>type.includes("6E0028")?"":"probably")} as unknown as HTMLVideoElement;const source={...info,tracks:[{index:0,kind:"video",codec:"h264",profile:"High 10",bit_depth:10}]};const caps=await playbackCapabilities(source,video);expect(caps.source_video_supported).toBe(false);expect(caps.source_hls_video_supported).toBe(false);expect(caps.hls_video_codecs).toContain("h264");
  vi.stubGlobal("navigator",{userAgent:"Chrome/145.0",mediaCapabilities:{decodingInfo:vi.fn().mockResolvedValue({supported:false})}});vi.mocked(video.canPlayType).mockReturnValue("probably");expect((await playbackCapabilities(source,video)).source_video_supported).toBe(false);
 });
 it("checks AAC profiles per original track and never claims TrueHD/DTS/PCM from generic audio support",()=>{
  const video={canPlayType:vi.fn((type:string)=>type.includes("40.5")?"":"probably")} as unknown as HTMLVideoElement;
  expect(originalAudioSupported({index:1,kind:"audio",codec:"aac",profile:"LC"},video)).toBe(true);expect(originalAudioSupported({index:2,kind:"audio",codec:"aac",profile:"HE-AAC"},video)).toBe(false);
  for(const codec of ["truehd","dts","pcm_s24le"])expect(originalAudioSupported({index:1,kind:"audio",codec},video)).toBe(false);
 });
 it("retains usable AAC-LC indexes without claiming unsupported HE-AAC copy, and probes independent AAC-LC output",async()=>{
  vi.stubGlobal("MediaSource",{isTypeSupported:(mime:string)=>!mime.includes("40.5")});const data={...info,remux_allowed:true,audio_conversion_allowed:true,tracks:[{index:0,kind:"video",codec:"h264"},{index:1,kind:"audio",codec:"aac",profile:"HE-AAC"},{index:2,kind:"audio",codec:"aac",profile:"LC"}]};const caps=await playbackCapabilities(data,{canPlayType:()=>"probably"} as unknown as HTMLVideoElement);expect(caps.hls_audio_track_indexes).toEqual([2]);expect(caps.hls_audio_codecs).toEqual(["aac"]);expect(caps.hls_aac_supported).toBe(true);expect(losslessAudioAllowed(data,caps,1)).toBe(false);expect(losslessAudioAllowed(data,caps,2)).toBe(true);expect(audioDeliveryAllowed(data,caps,1)).toBe(true);
 });
 it("does not allow scoped audio conversion to imply video conversion for a source outside fMP4 copy support",async()=>{
  vi.stubGlobal("MediaSource",{isTypeSupported:()=>true});const data={...info,audio_conversion_allowed:true,conversion_allowed:false,remux_allowed:true,tracks:[{index:0,kind:"video",codec:"vp9"},{index:1,kind:"audio",codec:"dts"}]};const caps=await playbackCapabilities(data,{canPlayType:()=>"probably"} as unknown as HTMLVideoElement);expect(caps.hls_video_codecs).not.toContain("vp9");expect(audioDeliveryAllowed(data,caps,1)).toBe(false);expect(audioDeliveryAllowed({...data,conversion_allowed:true},caps,1)).toBe(true);
 });
 it("retains AVC8 encoded-output support when source High10 native and HLS decoding are unsupported",async()=>{
  vi.stubGlobal("MediaSource",{isTypeSupported:(mime:string)=>!mime.includes("6E0028")});const data={...info,remux_allowed:true,audio_conversion_allowed:true,conversion_allowed:false,tracks:[{index:0,kind:"video",codec:"h264",profile:"High 10",bit_depth:10},{index:1,kind:"audio",codec:"aac",profile:"LC"}]};const caps=await playbackCapabilities(data,{canPlayType:(mime:string)=>mime.includes("6E0028")?"":"probably"} as unknown as HTMLVideoElement);expect(caps.source_video_supported).toBe(false);expect(caps.source_hls_video_supported).toBe(false);expect(caps.hls_video_codecs).toContain("h264");expect(caps.hls_audio_track_indexes).toEqual([1]);expect(caps.hls_aac_supported).toBe(false);expect(losslessAudioAllowed(data,caps,1)).toBe(false);expect(audioDeliveryAllowed(data,caps,1)).toBe(false);expect(audioDeliveryAllowed({...data,conversion_allowed:true},caps,1)).toBe(true);
 });
 it("separates native Main10 HEVC support from unsupported source HLS and supported HEVC8 output",async()=>{
  vi.stubGlobal("MediaSource",{isTypeSupported:(mime:string)=>!mime.includes("hvc1.2.4")});const data={...info,remux_allowed:true,tracks:[{index:0,kind:"video",codec:"hevc",profile:"Main 10",bit_depth:10,pixel_format:"yuv420p10le"},{index:1,kind:"audio",codec:"aac"}]};const caps=await playbackCapabilities(data,{canPlayType:()=>"probably"} as unknown as HTMLVideoElement);expect(caps.source_video_supported).toBe(true);expect(caps.source_hls_video_supported).toBe(false);expect(caps.hls_video_codecs).toContain("hevc");expect(caps.hls_audio_track_indexes).toEqual([1]);expect(losslessAudioAllowed(data,{...caps,hls_audio_track_indexes:[1]},1)).toBe(false);expect(losslessAudioAllowed(data,{...caps,source_hls_video_supported:undefined,hls_audio_track_indexes:[1]},1)).toBe(true);
 });
 it("requires every advertised encoded output to support copied audio when source video is unsupported",async()=>{
  const data={...info,tracks:[{index:0,kind:"video",codec:"h264",profile:"High 10",bit_depth:10},{index:1,kind:"audio",codec:"aac",profile:"LC"}]};const video={canPlayType:()=>"probably"} as unknown as HTMLVideoElement;
  vi.stubGlobal("MediaSource",{isTypeSupported:(mime:string)=>!mime.includes("6E0028")&&!(mime.includes("av01")&&mime.includes("mp4a"))});let caps=await playbackCapabilities(data,video);expect(caps.hls_video_codecs).toContain("av1");expect(caps.hls_audio_track_indexes).toEqual([]);
  vi.stubGlobal("MediaSource",{isTypeSupported:(mime:string)=>mime.startsWith("audio/")});caps=await playbackCapabilities(data,video);expect(caps.hls_video_codecs).toEqual([]);expect(caps.hls_audio_track_indexes).toEqual([]);
  vi.stubGlobal("MediaSource",{isTypeSupported:(mime:string)=>!mime.includes("6E0028")&&!mime.includes("40.5")});caps=await playbackCapabilities({...data,tracks:[data.tracks[0],{...data.tracks[1],profile:"HE-AAC"}]},video);expect(caps.hls_audio_track_indexes).toEqual([]);
 });
 it("requires remux permission for an already compatible stream instead of inventing an unnecessary audio encode",async()=>{
  vi.stubGlobal("MediaSource",{isTypeSupported:()=>true});const data={...info,remux_allowed:false,audio_conversion_allowed:true,conversion_allowed:false,tracks:[{index:0,kind:"video",codec:"h264"},{index:1,kind:"audio",codec:"aac",profile:"LC"},{index:2,kind:"audio",codec:"truehd"}]};const caps=await playbackCapabilities(data,{canPlayType:()=>"probably"} as unknown as HTMLVideoElement);expect(audioDeliveryAllowed(data,caps,1)).toBe(false);expect(audioDeliveryAllowed(data,caps,2)).toBe(true);expect(audioDeliveryAllowed({...data,conversion_allowed:true},caps,1)).toBe(false);expect(audioDeliveryAllowed({...data,remux_allowed:true},caps,1)).toBe(true);expect(audioDeliveryAllowed({...data,conversion_allowed:true},{...caps,source_hls_video_supported:false},1)).toBe(true);
 });
});

it("keeps compatible audio selectable inside an already authorized video encode with remux disabled",async()=>{
 vi.stubGlobal("MediaSource",{isTypeSupported:()=>true});
 const data={...info,conversion_allowed:true,remux_allowed:false,tracks:[{index:0,kind:"video",codec:"h264"},{index:1,kind:"audio",codec:"aac"},{index:2,kind:"audio",codec:"truehd"}]};
 const caps=await playbackCapabilities(data,{canPlayType:()=>"probably"} as unknown as HTMLVideoElement);
 expect(audioDeliveryAllowed(data,caps,1)).toBe(false);
 expect(audioDeliveryAllowed(data,caps,1,{videoEncoding:true})).toBe(true);
 const bandwidth={...data,conversion_allowed:false,audio_conversion_allowed:false,bandwidth_adaptation_allowed:true};
 expect(audioDeliveryAllowed(bandwidth,caps,1,{videoEncoding:true,bandwidthBudget:2000000})).toBe(true);
 expect(audioDeliveryAllowed(bandwidth,caps,2,{videoEncoding:true,bandwidthBudget:2000000})).toBe(false);
});

it("bounds a stalled browser capability probe without discarding canPlayType evidence", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("navigator", { userAgent: "Chrome/145.0", mediaCapabilities: { decodingInfo: () => new Promise(() => {}) } });
  const video = { canPlayType: () => "probably" } as unknown as HTMLVideoElement;
  const probing = playbackCapabilities({ ...info, tracks: [{ index: 0, kind: "video", codec: "h264" }] }, video);
  await vi.advanceTimersByTimeAsync(1500);
  expect((await probing).source_video_supported).toBe(true);
  vi.useRealTimers();
});

it("keeps multichannel AAC native for automatic copy optimizations without restricting explicit copy",async()=>{
 vi.stubGlobal("MediaSource",{isTypeSupported:()=>true});
 const data:PlaybackInfo={...info,container:"mkv",remux_allowed:true,tracks:[{index:0,kind:"video",codec:"hevc",profile:"Main 10",bit_depth:10},{index:1,kind:"audio",codec:"aac",profile:"LC",channels:8}]};
 const caps=await playbackCapabilities(data,{canPlayType:()=>"probably"} as unknown as HTMLVideoElement);
 expect(losslessAudioAllowed(data,caps,1)).toBe(true);
 expect(automaticStreamCopyAllowed(data,caps,1)).toBe(false);
 expect(automaticStreamCopyAllowed({...data,tracks:data.tracks.map(t=>t.kind==="audio"?{...t,channels:2}:t)},caps,1)).toBe(true);
 expect(automaticStreamCopyAllowed({...data,tracks:data.tracks.map(t=>t.kind==="audio"?{...t,channels:6,codec:"ac3"}:t)},caps,1)).toBe(true);
});
