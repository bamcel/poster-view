import {useTrackingOverlays} from "../lib/libraryDisplay";
import {Switch} from "./ui";
export default function BookPreferences(){
 const [tracking,setTracking,settings]=useTrackingOverlays();
 const row=(label:string,checked:boolean,onChange:()=>void)=><div className="flex items-center justify-between gap-4"><span className="text-sm text-muted">{label}</span><Switch label={label} checked={checked} disabled={settings.busy} onChange={onChange}/></div>;
 return <section className="space-y-5"><h3 className="text-xl font-semibold">Book preferences</h3>
 {row("Display reading status",tracking,()=>setTracking(!tracking))}
 {row("Colored edition shimmer",settings.coloredEffect==="shimmer"||settings.coloredEffect==="both",()=>settings.toggleColoredEffect("shimmer"))}
 {row("Colored edition badge",settings.coloredEffect==="badge"||settings.coloredEffect==="both",()=>settings.toggleColoredEffect("badge"))}
 {row("Colored edition title",settings.coloredTitle,()=>settings.setColoredTitle(!settings.coloredTitle))}
 <p className="text-xs text-faint">Changes save automatically and apply across book libraries.</p>
 {settings.error&&<p role="alert" className="text-sm text-danger">{settings.error}</p>}
 </section>;
}
