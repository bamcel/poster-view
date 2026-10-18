import { useState, type ReactNode, type CSSProperties } from "react";
import PopupPage from "./PopupPage";
import {ACTION_BUTTON} from "./ui";


export default function LibraryPopup({ title, label, icon, children, style, editorStyle: _editorStyle=false }: { title: string; label: string; icon: ReactNode; children: ReactNode; style?: CSSProperties; editorStyle?:boolean }) {
  const [open,setOpen]=useState(false);
  return <>
    <button type="button" style={style} aria-label={label} title={title} onClick={() => setOpen(true)}
      className="pv-profile-trigger grid size-10 shrink-0 place-items-center rounded-full text-white focus-visible:outline-accent">{icon}</button>
    {open&&<PopupPage title={title} onClose={()=>setOpen(false)} dismissOnBackdrop footer={<><span/><button className={ACTION_BUTTON} onClick={()=>setOpen(false)}>Done</button></>}>{children}</PopupPage>}
  </>;
}
