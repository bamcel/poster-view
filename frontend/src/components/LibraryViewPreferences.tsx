import { useEffect, useState } from "react";
import { useYoutubeHomepagePreferences } from "../lib/youtubeHomepagePreferences";

const event = "posterview-library-view";
const youtubeBackgroundEvent = "posterview-youtube-background";
const youtubeBackgroundKey = (library: string) => `posterview.youtubeBackground.${library}`;
function readYoutubeBannerBackground(library: string) {
  try { return localStorage.getItem(youtubeBackgroundKey(library)) === "banner"; }
  catch { return false; }
}
export function useYoutubeBannerBackground(library: string) {
  const [enabled, updateEnabled] = useState(() => readYoutubeBannerBackground(library));
  useEffect(() => {
    const refresh = () => updateEnabled(readYoutubeBannerBackground(library));
    refresh();
    window.addEventListener(youtubeBackgroundEvent, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(youtubeBackgroundEvent, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, [library]);
  const setEnabled = (value: boolean) => {
    localStorage.setItem(youtubeBackgroundKey(library), value ? "banner" : "backdrop");
    updateEnabled(value);
    window.dispatchEvent(new Event(youtubeBackgroundEvent));
  };
  return { enabled, setEnabled };
}
const youtubeAllVideosEvent = "posterview-youtube-all-videos";
export function useYoutubeAllVideos(library: string) {
  const key = `posterview.youtubeAllVideos.${library}`;
  const read = () => { try { return localStorage.getItem(key) !== "hidden"; } catch { return true; } };
  const [visible, setVisible] = useState(read);
  useEffect(() => {
    const refresh = () => setVisible(read());
    refresh();
    window.addEventListener(youtubeAllVideosEvent, refresh);
    window.addEventListener("storage", refresh);
    return () => { window.removeEventListener(youtubeAllVideosEvent, refresh); window.removeEventListener("storage", refresh); };
  }, [key]);
  const update = (value: boolean) => {
    localStorage.setItem(key, value ? "visible" : "hidden");
    setVisible(value);
    window.dispatchEvent(new Event(youtubeAllVideosEvent));
  };
  return { visible, setVisible: update };
}
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
export default function LibraryViewPreferences({ library, defaultBackdrop = false, youtube = false }: { library: string; defaultBackdrop?: boolean; youtube?: boolean }) {
  const { enabled, toggle } = useBackdropView(library, defaultBackdrop);
  const { enabled: bannerBackground, setEnabled: setBannerBackground } = useYoutubeBannerBackground(library);
  const homepage = useYoutubeHomepagePreferences(library);
  const allVideos = useYoutubeAllVideos(library);
  const [saved,setSaved]=useState(false);
  return <section className="space-y-3"><label className="block text-sm font-semibold">Display<select aria-label="Display" value={enabled ? "backdrop" : "poster"} onChange={e => { if ((e.target.value === "backdrop") !== enabled) {toggle();setSaved(true);} }} className="mt-2 h-10 w-full rounded border border-border bg-surface-2 px-3 text-sm font-normal text-white outline-none focus:border-accent"><option value="poster">Poster</option><option value="backdrop">Backdrop</option></select></label><p className="text-xs text-faint">Use portrait posters or landscape backdrops. Animated artwork is supported. Saved for this library in this browser; connected servers are unchanged.</p>{youtube && <><label className="flex items-center gap-3 text-sm font-semibold"><input type="checkbox" role="switch" checked={!allVideos.visible} onChange={e => { allVideos.setVisible(!e.target.checked); setSaved(true); }} />Hide All Videos</label><p className="text-xs text-faint">Hide the All Videos card and shortcut on channel pages. Playlists remain visible. Saved for this library in this browser.</p><label className="block text-sm font-semibold">Page background<select aria-label="Page background" value={bannerBackground ? "banner" : "backdrop"} onChange={e => { setBannerBackground(e.target.value === "banner"); setSaved(true); }} className="mt-2 h-10 w-full rounded border border-border bg-surface-2 px-3 text-sm font-normal text-white outline-none focus:border-accent"><option value="backdrop">Backdrop</option><option value="banner">Banner</option></select></label><p className="text-xs text-faint">Banner affects only the page background; wide cards keep using the backdrop. If a banner is missing, the background uses the backdrop. Saved for this library in this browser.</p><label className="flex items-center gap-3 text-sm font-semibold"><input type="checkbox" role="switch" checked={homepage.featured} onChange={e => { homepage.setFeatured(e.target.checked); setSaved(true); }} />Show channels in the homepage banner</label><p className="text-xs text-faint">Only channels are included; videos and playlists never appear in the homepage banner.</p><label className="flex items-center gap-3 text-sm font-semibold"><input type="checkbox" role="switch" checked={homepage.background} onChange={e => { homepage.setBackground(e.target.checked); setSaved(true); }} />Use channel backdrops on the homepage</label><p className="text-xs text-faint">Allow channel artwork in homepage backgrounds. With both options off, this library's artwork stays inside the library. Saved for this library in this browser.</p></>}{saved&&<p role="status" className="text-xs text-muted">Changes saved automatically</p>}</section>;
}
