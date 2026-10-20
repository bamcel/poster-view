import {Play} from "lucide-react";
import PopupPage from "./PopupPage";

export default function ResumePlaybackDialog({title,onChoose,onClose}:{title:string;onChoose:(resume:boolean)=>void;onClose:()=>void}) {
 return <PopupPage title="Play video" description={title} layout="compact" onClose={onClose} plainClose dismissOnBackdrop>
  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
   <button type="button" className="flex min-h-11 items-center justify-center gap-2 rounded-full border border-border bg-white/5 px-4 py-2 text-sm font-semibold hover:bg-white/10" onClick={()=>onChoose(false)}><Play size={18} aria-hidden="true"/>Play from beginning</button>
   <button type="button" className="flex min-h-11 items-center justify-center gap-2 rounded-full border border-border bg-white/5 px-4 py-2 text-sm font-semibold hover:bg-white/10" onClick={()=>onChoose(true)}><Play size={18} aria-hidden="true"/>Resume</button>
  </div>
 </PopupPage>;
}