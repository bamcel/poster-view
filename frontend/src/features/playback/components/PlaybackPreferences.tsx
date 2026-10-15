import {useEffect,useState} from "react";
import {useQuery} from "@tanstack/react-query";
import {watchApi,type PlaybackPreferences as Preferences} from "../api/watch";
import {SETTINGS_BUTTON} from "../../../components/SettingsPageFrame";
import {subtitleAppearance} from "../lib/subtitleAppearance";
const input="mt-2 w-full rounded-lg border border-border bg-input px-3 py-2 text-sm";
export default function PlaybackPreferences() {
  const query=useQuery({queryKey:["playback-preferences"],queryFn:()=>watchApi.preferences()});
  const [audioText,setAudioText]=useState(""),[subtitleText,setSubtitleText]=useState("");
  const [settings,setSettings]=useState<Preferences>(),[saving,setSaving]=useState(false),[message,setMessage]=useState(""),[error,setError]=useState("");
  useEffect(()=>{if(query.data){setSettings({...query.data,remember_series_tracks:query.data.remember_series_tracks??true,...subtitleAppearance(query.data)});setAudioText(query.data.audio_languages.join(", "));setSubtitleText(query.data.subtitle_languages.join(", "));}},[query.data]);
  if(query.isError)return <p role="alert" className="text-danger">{query.error.message}</p>;
  if(!settings)return <p role="status" className="text-muted">Loading playback preferences…</p>;
  const change=<K extends keyof Preferences>(key:K,value:Preferences[K])=>{setSettings({...settings,[key]:value});setMessage("");setError("");};
  const toggle=(key:"remember_series_tracks"|"prefer_default_audio"|"remember_audio"|"remember_subtitles"|"autoplay_next"|"up_next",label:string,help:string)=><label className="flex items-start justify-between gap-5 py-3"><span><span className="block text-sm font-medium">{label}</span><span className="mt-1 block text-xs text-muted">{help}</span></span><input type="checkbox" role="switch" aria-label={label} checked={settings[key]} onChange={e=>change(key,e.target.checked)} className="mt-1 size-4 shrink-0 accent-accent"/></label>;
  const number=(key:"resume_rewind_seconds"|"skip_back_seconds"|"skip_forward_seconds"|"still_watching_minutes"|"still_watching_timeout_minutes"|"subtitle_size",label:string,min:number,max:number,help?:string)=><label className="block text-sm">{label}<input type="number" className={input} value={settings[key]??5} min={min} max={max} onChange={e=>change(key,Number(e.target.value))}/>{help&&<span className="mt-1 block text-xs text-muted">{help}</span>}</label>;
  return <form className="max-w-3xl space-y-6" onSubmit={async e=>{e.preventDefault();setSaving(true);setError("");try{const value=await watchApi.savePreferences({...settings,audio_languages:audioText.split(",").map(s=>s.trim()).filter(Boolean),subtitle_languages:subtitleText.split(",").map(s=>s.trim()).filter(Boolean)});setSettings(value);setMessage("Playback preferences saved.");}catch(e){setError(e instanceof Error?e.message:"Could not save preferences.");}finally{setSaving(false);}}}>
    <fieldset className="rounded-xl border border-border p-5"><legend className="px-2 font-semibold">Series track preferences</legend>
      {toggle("remember_series_tracks","Remember audio and subtitles across a series","Use your selected language and track characteristics in other episodes. Saved choices for an individual video take priority. Applies only to your profile.")}
    </fieldset>
    <fieldset className="rounded-xl border border-border p-5"><legend className="px-2 font-semibold">Audio</legend>
      <label className="block text-sm">Preferred audio languages<input aria-label="Preferred audio languages" className={input} value={audioText} onChange={e=>{setAudioText(e.target.value);setMessage("");}}/><span className="mt-1 block text-xs text-muted">Language codes in preference order, such as en, ja, ko.</span></label>
      {toggle("prefer_default_audio","Prefer default audio track","Use the file’s default audio track before language preferences.")}
      {toggle("remember_audio","Remember audio selections","Remember your selected track for each video.")}
    </fieldset>
    <fieldset className="space-y-4 rounded-xl border border-border p-5"><legend className="px-2 font-semibold">Subtitles</legend>
      <label className="block text-sm">Preferred subtitle languages<input aria-label="Preferred subtitle languages" className={input} value={subtitleText} onChange={e=>{setSubtitleText(e.target.value);setMessage("");}}/></label>
      <label className="block text-sm">Subtitle mode<select className={input} value={settings.subtitle_mode} onChange={e=>change("subtitle_mode",e.target.value as Preferences["subtitle_mode"])}>{[["default","File default"],["smart","Smart: subtitles for other audio languages"],["forced","Forced only"],["hearing_impaired","Hearing impaired"],["always","Always"],["off","Off"]].map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
      {toggle("remember_subtitles","Remember subtitle selections","Per-video selections take priority over automatic subtitle preferences.")}
      {number("subtitle_size","Text subtitle size (%)",50,200,"Applies to plain text tracks; ASS / SSA tracks preserve their embedded styling.")}
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block text-sm">Text subtitle color<input aria-label="Text subtitle color" type="color" value={settings.subtitle_color??"#ffffff"} onChange={event=>change("subtitle_color",event.target.value)} className={`${input} h-11 cursor-pointer`}/></label>
        <label className="block text-sm">Text subtitle shadow<select className={input} value={settings.subtitle_shadow??"none"} onChange={event=>change("subtitle_shadow",event.target.value as Preferences["subtitle_shadow"])}><option value="none">None</option><option value="drop">Drop shadow</option><option value="outline">Outline</option></select></label>
        <label className="block text-sm">Text subtitle background<select className={input} value={settings.subtitle_background??"dark"} onChange={event=>change("subtitle_background",event.target.value as Preferences["subtitle_background"])}><option value="none">None</option><option value="dark">Dark</option><option value="light">Light</option></select></label>
        <label className="block text-sm">Text subtitle position<select className={input} value={settings.subtitle_position??"auto"} onChange={event=>change("subtitle_position",event.target.value as Preferences["subtitle_position"])}><option value="auto">Automatic (preserve cue placement)</option><option value="top">Top</option><option value="bottom">Bottom</option></select></label>
      </div>
      <p className="text-xs text-muted">Appearance applies to plain text subtitles. Styled ASS / SSA subtitles retain their own formatting.</p>
    </fieldset>
    <fieldset className="rounded-xl border border-border p-5"><legend className="px-2 font-semibold">Watching</legend>
      {toggle("autoplay_next","Play next episode automatically","Continue to the next available episode when the current one ends.")}
      {toggle("up_next","Show Up Next preview","Display the next episode near the end of playback.")}
      <div className="mt-3 grid gap-4 sm:grid-cols-2">{number("skip_back_seconds","Skip back (seconds)",5,120)}{number("skip_forward_seconds","Skip forward (seconds)",5,120)}{number("resume_rewind_seconds","Rewind on resume (seconds)",0,30,"Only when resuming saved progress, not after each pause.")}{number("still_watching_minutes","Paused inactivity before prompt (minutes)",0,1440,"Only while paused. 0 disables the prompt.")}{number("still_watching_timeout_minutes","Unanswered prompt before exit (minutes)",1,1440,"Saves progress and frees playback slots when the prompt times out.")}</div>
    </fieldset>
    {error&&<p role="alert" className="text-sm text-danger">{error}</p>}{message&&<p role="status" className="text-sm text-accent">{message}</p>}
    <button disabled={saving} className={SETTINGS_BUTTON}>{saving?"Saving…":"Save preferences"}</button>
  </form>;
}
