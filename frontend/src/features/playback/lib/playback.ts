import type { PlaybackInfo, PlaybackPreferences, PlaybackTrack, WatchState } from "../api/playback";

export function playbackTime(seconds: number): string {
  const value = Math.max(0,Math.floor(Number.isFinite(seconds)?seconds:0));
  const hours = Math.floor(value/3600), minutes = Math.floor(value%3600/60);
  return `${hours ? `${hours}:${String(minutes).padStart(2,"0")}` : minutes}:${String(value%60).padStart(2,"0")}`;
}
const languages: Record<string,string> = {eng:"en",jpn:"ja",fre:"fr",fra:"fr",ger:"de",deu:"de",spa:"es",ita:"it",kor:"ko",chi:"zh",zho:"zh",por:"pt",rus:"ru",ara:"ar"};
export const normalizeLanguage = (value?: string | null) => { const key=(value??"").toLowerCase().split("-")[0]; return languages[key]??key; };
export function trackLabel(track: PlaybackTrack): string {
  const language=normalizeLanguage(track.language);
  let name=track.language??"Unknown language";
  try { if(language&&language!=="und") name=new Intl.DisplayNames([navigator.language||"en"],{type:"language"}).of(language)??name; } catch { /* Keep the provider label. */ }
  return [track.title||name,track.codec?.toUpperCase(),track.channels?`${track.channels} ch`:null,track.default?"Default":null,track.forced?"Forced":null,track.hearing_impaired?"Hearing impaired":null].filter(Boolean).join(" · ");
}
export function selectTracks(info: PlaybackInfo, preferences: PlaybackPreferences, state: WatchState): {audio:number|null; subtitle:number} {
  const audio=info.tracks.filter(track=>track.kind==="audio"), subtitles=info.tracks.filter(track=>track.kind==="subtitle");
  const matches=(track:PlaybackTrack, list:string[])=>list.some(value=>normalizeLanguage(value)===normalizeLanguage(track.language));
  const languageOrder=(tracks:PlaybackTrack[],list:string[])=>tracks.filter(track=>matches(track,list)).sort((left,right)=>list.findIndex(language=>normalizeLanguage(language)===normalizeLanguage(left.language))-list.findIndex(language=>normalizeLanguage(language)===normalizeLanguage(right.language)));
  let chosenAudio=preferences.remember_audio?audio.find(track=>track.index===state.audio_index):undefined;
  chosenAudio??=preferences.prefer_default_audio?audio.find(track=>track.default):undefined;
  chosenAudio??=languageOrder(audio,preferences.audio_languages)[0]??audio.find(track=>track.default)??audio[0];
  if(preferences.remember_subtitles&&state.subtitle_index===-1) return {audio:chosenAudio?.index??null,subtitle:-1};
  const remembered=preferences.remember_subtitles?subtitles.find(track=>track.index===state.subtitle_index):undefined;
  if(remembered) return {audio:chosenAudio?.index??null,subtitle:remembered.index};
  const preferred=languageOrder(subtitles,preferences.subtitle_languages);
  let selected: PlaybackTrack|undefined;
  switch(preferences.subtitle_mode){
    case "off": break;
    case "forced": selected=preferred.find(track=>track.forced)??subtitles.find(track=>track.forced); break;
    case "hearing_impaired": selected=preferred.find(track=>track.hearing_impaired)??subtitles.find(track=>track.hearing_impaired)??preferred[0]; break;
    case "always": selected=preferred[0]??subtitles.find(track=>track.default)??subtitles[0]; break;
    case "smart": {
      const understood=chosenAudio&&matches(chosenAudio,preferences.audio_languages);
      selected=understood?preferred.find(track=>track.forced)??subtitles.find(track=>track.forced):preferred[0]??subtitles.find(track=>track.default);
      break;
    }
    default: selected=subtitles.find(track=>track.default||track.forced);
  }
  return {audio:chosenAudio?.index??null,subtitle:selected?.index??-1};
}
export function safePlayerReturn(value: string|null): string { return value&&value.startsWith("/")&&!value.startsWith("//")&&!/[\\\r\n]/.test(value)?value:"/"; }
export async function playbackCapabilities(info: PlaybackInfo, video: HTMLVideoElement) {
  const videoTypes: Record<string,string>={h264:'video/mp4; codecs="avc1.640028"',hevc:'video/mp4; codecs="hvc1.1.6.L123.B0"',av1:'video/mp4; codecs="av01.0.08M.08"',vp9:'video/webm; codecs="vp09.00.41.08"',vp8:'video/webm; codecs="vp8"'};
  const audioTypes:Record<string,string>={aac:'audio/mp4; codecs="mp4a.40.2"',mp3:'audio/mpeg',opus:'audio/webm; codecs="opus"',vorbis:'audio/webm; codecs="vorbis"',flac:'audio/flac'};
  const videoCodecs:string[]=[];
  let sourceVideoSupported=true;
  for(const [codec,baseType] of Object.entries(videoTypes)) {
    const stream=info.tracks.find(track=>track.kind==="video"&&track.codec===codec);
    if(!video.canPlayType(baseType)){if(stream)sourceVideoSupported=false;continue;}
    videoCodecs.push(codec);
    const highDepth=(stream?.bit_depth??8)>8||/10|12/.test(stream?.profile??"");
    const contentType=codec==="hevc"&&highDepth?'video/mp4; codecs="hvc1.2.4.L153.B0"':codec==="av1"&&highDepth?'video/mp4; codecs="av01.0.08M.10"':codec==="h264"&&highDepth?'video/mp4; codecs="avc1.6E0028"':baseType;
    if(stream&&!video.canPlayType(contentType)){sourceVideoSupported=false;continue;}
    if(stream&&navigator.mediaCapabilities?.decodingInfo) {
      try {
        const support=await navigator.mediaCapabilities.decodingInfo({type:"file",video:{contentType,width:stream.width||1920,height:stream.height||1080,bitrate:stream.bitrate||8_000_000,framerate:stream.frame_rate||24}});
        if(!support.supported)sourceVideoSupported=false;
      } catch { /* Runtime decode fallback handles inconclusive capability checks. */ }
    }
  }
  const browser=navigator as Navigator&{userAgentData?:{brands?:{brand:string}[]}};
  const chromium=!!browser.userAgentData?.brands?.some(value=>/chromium|google chrome|microsoft edge/i.test(value.brand))||/(?:Chrome|Chromium|Edg)\/\d/i.test(browser.userAgent);
  const operaTv=/Opera\s*TV|OperaTV|OMI\/|HbbTV/i.test(browser.userAgent);
  let nativeAudio=false;
  try{const tracks=(video as HTMLVideoElement&{audioTracks?:{length:number}}).audioTracks;nativeAudio=!!tracks&&Number.isInteger(tracks.length)&&tracks.length>=0;}catch{/* An unavailable browser API must not enable nondefault audio. */}
  return { source_video_supported:sourceVideoSupported, native_audio_tracks:nativeAudio, video_codecs:videoCodecs, audio_codecs:Object.keys(audioTypes).filter(codec=>!!video.canPlayType(audioTypes[codec])),containers:[...(video.canPlayType("video/mp4")?["mp4","mov"]:[]),...(video.canPlayType("video/webm")?["webm"]:[]),...(video.canPlayType("video/x-matroska")||video.canPlayType("video/mkv")||(chromium&&!operaTv)?["mkv"]:[])] };
}
