import {apiRequest} from "../../../api/client";
export interface YtdlSettings {enabled:boolean;library_id:string;directory:string;video_codec:"auto"|"h264"|"vp9"|"av1";audio_codec:"auto"|"aac"|"opus";container:"mp4"|"mkv"|"webm";max_height:number;max_fps:number;fallback:"best"|"strict";convert:boolean;subtitles:boolean;subtitle_languages:string[];chapters:boolean;thumbnail:boolean}
export interface YtdlEntry {kind?:"video"|"playlist";id:string;url:string;title:string;description:string;channel:string;channel_id:string;upload_date:string;duration:number|null;thumbnail:string|null;playlist_id:string|null;playlist_title:string|null;playlist_index:number|null}
export interface YtdlInfo {id:string;title:string;description:string;channel:string;channel_id:string;kind:"video"|"playlist"|"channel";entries:YtdlEntry[];formats:{format_id:string;height:number|null;fps:number|null;vcodec:string;acodec:string;ext:string}[]}
export interface YtdlJob {id:string;url:string;title:string;status:string;progress:number|null;speed:string|null;eta:string|null;error:string|null;created_at:string;settings:YtdlSettings}
export interface YtdlConfiguration {settings:YtdlSettings;dependencies:{yt_dlp:string|null;ffmpeg:string|null;js_runtime:string|null}}
export const ytdl={
 configuration:()=>apiRequest<YtdlConfiguration>("/plugins/ytdl"),
 save:(settings:YtdlSettings)=>apiRequest<YtdlSettings>("/plugins/ytdl",{method:"PUT",body:JSON.stringify(settings)}),
 inspect:(url:string)=>apiRequest<YtdlInfo>("/plugins/ytdl/inspect",{method:"POST",body:JSON.stringify({url})}),
 jobs:()=>apiRequest<YtdlJob[]>("/plugins/ytdl/jobs"),
 submit:(url:string,video_ids:string[],settings:YtdlSettings)=>apiRequest<{id:string}>("/plugins/ytdl/jobs",{method:"POST",body:JSON.stringify({url,video_ids,settings})}),
 action:(id:string,action:"cancel"|"retry")=>apiRequest<YtdlJob>(`/plugins/ytdl/jobs/${encodeURIComponent(id)}/${action}`,{method:"POST"}),
};
export const youtubeOptions={read_nfo:true,save_nfo:true,local_artwork:true,save_artwork:true,fetch_missing:false,show_missing_files:false,metadata_providers:{},image_providers:{},sample_ignore_mb:0};
