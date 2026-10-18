import {useTrackingOverlays} from "../lib/libraryDisplay";
import {Switch} from "./ui";
export default function BookPreferences(){
 const [tracking,setTracking,settings]=useTrackingOverlays();
 const row=(label:string,checked:boolean,onChange:()=>void)=><div className="flex items-center justify-between gap-4"><span className="text-sm text-muted">{label}</span><Switch label={label} checked={checked} disabled={settings.busy} onChange={onChange}/></div>;
 return <section className="settings-panel space-y-5 rounded-xl border border-border bg-window p-5"><div><h3 className="text-lg font-semibold">Book display</h3><p className="mt-1 text-sm text-muted">Reading indicators and colored edition styling.</p></div>
 {row("Display reading status",tracking,()=>setTracking(!tracking))}
 {row("Colored edition shimmer",settings.coloredEffect==="shimmer"||settings.coloredEffect==="both",()=>settings.toggleColoredEffect("shimmer"))}
 {row("Colored edition badge",settings.coloredEffect==="badge"||settings.coloredEffect==="both",()=>settings.toggleColoredEffect("badge"))}
 {row("Colored edition title",settings.coloredTitle,()=>settings.setColoredTitle(!settings.coloredTitle))}
 <p className="text-xs text-faint">Changes save automatically and apply across book libraries.</p>
 {settings.saved&&!settings.busy&&!settings.error&&<p role="status" className="text-xs text-muted">Changes saved automatically</p>}
 {settings.error&&<p role="alert" className="text-sm text-danger">{settings.error}</p>}
 </section>;
}
