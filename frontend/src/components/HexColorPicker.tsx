import {useEffect,useRef,useState} from "react";

function hsv(hex:string):[number,number,number]{
 const [r,g,b]=[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255),max=Math.max(r,g,b),min=Math.min(r,g,b),d=max-min;
 const h=d===0?0:max===r?((g-b)/d+6)%6:max===g?(b-r)/d+2:(r-g)/d+4;
 return [h*60,max===0?0:d/max,max];
}
function hex(h:number,s:number,v:number){
 const c=v*s,x=c*(1-Math.abs((h/60)%2-1)),m=v-c;
 const channels=h<60?[c,x,0]:h<120?[x,c,0]:h<180?[0,c,x]:h<240?[0,x,c]:h<300?[x,0,c]:[c,0,x];
 return "#"+channels.map(n=>Math.round((n+m)*255).toString(16).padStart(2,"0")).join("").toUpperCase();
}
export default function HexColorPicker({value,onChange,label}:{value:string;onChange:(color:string)=>void;label:string}){
 const [open,setOpen]=useState(false),[draft,setDraft]=useState(value.toUpperCase());
 const [h,s,v]=hsv(value);const [hue,setHue]=useState(h);
 const root=useRef<HTMLDivElement>(null);
 useEffect(()=>{setDraft(value.toUpperCase());if(s>0)setHue(h);},[value,h,s]);
 useEffect(()=>{if(!open)return;const close=(event:PointerEvent)=>{if(!root.current?.contains(event.target as Node))setOpen(false);};document.addEventListener("pointerdown",close);return()=>document.removeEventListener("pointerdown",close);},[open]);
 const choose=(event:React.PointerEvent<HTMLDivElement>)=>{const box=event.currentTarget.getBoundingClientRect();onChange(hex(hue,Math.max(0,Math.min(1,(event.clientX-box.left)/box.width)),1-Math.max(0,Math.min(1,(event.clientY-box.top)/box.height))));};
 return <div ref={root} className="relative" onKeyDown={event=>{if(event.key==="Escape"){event.stopPropagation();setOpen(false);}}}>
 <button type="button" aria-label={`Choose ${label} color`} aria-expanded={open} onClick={()=>setOpen(!open)} className="mt-2 flex h-10 w-full items-center gap-3 rounded-lg border border-border bg-input px-3 text-left"><span className="size-4 shrink-0 rounded-sm border border-border" style={{backgroundColor:value}}/><span className="font-mono text-xs text-white">{value.toUpperCase()}</span></button>
 {open&&<div role="dialog" aria-label={`${label} color picker`} className="absolute right-0 top-full z-50 mt-2 w-64 max-w-full space-y-3 rounded-xl border border-border bg-sidebar p-3 shadow-xl">
 <div aria-label="Color saturation and brightness" className="relative h-36 touch-none cursor-crosshair overflow-hidden rounded-lg" style={{background:`linear-gradient(to top,black,transparent),linear-gradient(to right,white,transparent),hsl(${hue} 100% 50%)`}} onPointerDown={event=>{event.currentTarget.setPointerCapture(event.pointerId);choose(event);}} onPointerMove={event=>{if(event.buttons===1)choose(event);}}><span className="pointer-events-none absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow" style={{left:`${s*100}%`,top:`${(1-v)*100}%`}}/></div>
 <label className="block text-xs text-muted">Hue<input aria-label={`${label} hue`} type="range" min={0} max={359} value={hue} onChange={event=>{const next=Number(event.target.value);setHue(next);onChange(hex(next,s,v));}} className="mt-1 h-3 w-full cursor-pointer rounded-full" style={{background:"linear-gradient(to right,red,yellow,lime,cyan,blue,magenta,red)",appearance:"none"}}/></label>
 <label className="block text-xs text-muted">HEX<input aria-label={`${label} HEX color`} value={draft} maxLength={7} spellCheck={false} onChange={event=>{const next=event.target.value.toUpperCase();setDraft(next);if(/^#[0-9A-F]{6}$/.test(next))onChange(next);}} onBlur={()=>setDraft(value.toUpperCase())} className="mt-1 w-full rounded-lg border border-border bg-input px-3 py-2 font-mono text-sm text-white outline-none focus:border-accent"/></label>
 <button type="button" onClick={()=>setOpen(false)} className="w-full rounded-lg border border-border px-3 py-2 text-xs">Done</button>
 </div>}
 </div>;
}
