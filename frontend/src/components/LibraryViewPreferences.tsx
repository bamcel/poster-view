import { useEffect, useState } from "react";

const event = "posterview-library-view";
function read(library: string, defaultBackdrop = false) {
  try { const saved = localStorage.getItem(`posterview.libraryView.${library}`); return saved === null ? defaultBackdrop : saved === "backdrop"; }
  catch { return defaultBackdrop; }
}
export const posterGrid = "grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(125px,1fr))] sm:gap-5 sm:[grid-template-columns:repeat(auto-fill,minmax(150px,1fr))]";
export const backdropGrid = "grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(100%,187.5px),1fr))] sm:gap-5 sm:[grid-template-columns:repeat(auto-fill,minmax(min(100%,225px),1fr))]";
export function useBackdropView(library: string, defaultBackdrop = false) {
  const [enabled, setEnabled] = useState(() => read(library, defaultBackdrop));
  useEffect(() => {
    const refresh = () => setEnabled(read(library, defaultBackdrop));
    refresh();
    window.addEventListener(event, refresh);
    window.addEventListener("storage", refresh);
    return () => { window.removeEventListener(event, refresh); window.removeEventListener("storage", refresh); };
  }, [library, defaultBackdrop]);
  const toggle = () => {
    const next = !read(library, defaultBackdrop);
    localStorage.setItem(`posterview.libraryView.${library}`, next ? "backdrop" : "poster");
    setEnabled(next);
    window.dispatchEvent(new Event(event));
  };
  return { enabled, toggle };
}
export default function LibraryViewPreferences({ library, defaultBackdrop = false }: { library: string; defaultBackdrop?: boolean }) {
  const { enabled, toggle } = useBackdropView(library, defaultBackdrop);
  const [saved,setSaved]=useState(false);
  return <section className="space-y-3"><label className="block text-sm font-semibold">Display<select aria-label="Display" value={enabled ? "backdrop" : "poster"} onChange={e => { if ((e.target.value === "backdrop") !== enabled) {toggle();setSaved(true);} }} className="mt-2 h-10 w-full rounded border border-border bg-surface-2 px-3 text-sm font-normal text-white outline-none focus:border-accent"><option value="poster">Poster</option><option value="backdrop">Backdrop</option></select></label><p className="text-xs text-faint">Use portrait posters or landscape backdrops. Animated artwork is supported. Saved for this library in this browser; connected servers are unchanged.</p>{saved&&<p role="status" className="text-xs text-muted">Changes saved automatically</p>}</section>;
}
