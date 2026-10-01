import { useRef, type ReactNode, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

export default function LibraryPopup({ title, label, icon, children, style, editorStyle=false }: { title: string; label: string; icon: ReactNode; children: ReactNode; style?: CSSProperties; editorStyle?:boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  return <>
    <button type="button" style={style} aria-label={label} title={title} onClick={() => dialog.current?.showModal()}
      className="grid size-10 shrink-0 place-items-center rounded-full border border-border bg-surface-2 text-muted hover:text-white focus-visible:outline-accent">{icon}</button>
    {createPortal(<dialog ref={dialog} aria-label={title}
      onClick={e => { if (e.target === e.currentTarget) dialog.current?.close(); }}
      className={`fixed inset-0 m-auto max-h-[85dvh] ${editorStyle?"w-[min(52rem,calc(100vw-2rem))]":"w-[min(32rem,calc(100vw-2rem))]"} overflow-y-auto rounded-2xl border border-border bg-sidebar p-0 text-white shadow-2xl backdrop:bg-black/60 backdrop:backdrop-blur-sm`}>
      <div className={editorStyle?"p-6 sm:px-10 sm:py-6":"p-5 sm:p-6"}>
        <header className={`mb-5 flex items-center gap-4 ${editorStyle?"flex-row-reverse justify-end":"justify-between"}`}><h2 className="text-lg font-semibold">{title}</h2>
          <button type="button" aria-label={`Close ${title}`} onClick={() => dialog.current?.close()} className="rounded-lg p-2 text-muted hover:bg-surface-2 hover:text-white"><X className="size-5" /></button>
        </header>
        {children}
      </div>
    </dialog>, document.body)}
  </>;
}
