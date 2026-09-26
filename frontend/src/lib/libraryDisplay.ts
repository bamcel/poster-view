import { useSyncExternalStore } from "react";

const key = "posterview.libraryDisplay.books.trackingOverlays";
const event = "posterview:library-display";
function subscribe(update: () => void) {
  window.addEventListener(event, update);
  window.addEventListener("storage", update);
  return () => { window.removeEventListener(event, update); window.removeEventListener("storage", update); };
}
function read() {
  try { return localStorage.getItem(key) !== "false"; } catch { return true; }
}
export function useTrackingOverlays() {
  const enabled = useSyncExternalStore(subscribe, read, () => true);
  const setEnabled = (value: boolean) => {
    try { localStorage.setItem(key, String(value)); } catch { return; }
    window.dispatchEvent(new Event(event));
  };
  return [enabled, setEnabled] as const;
}
