import {useCallback, useEffect, useMemo, useState} from "react";

/** Keep the featured title stable through catalog refreshes and incidental renders. */
export function useFeaturedRotation(keys: string[]) {
  const signature = JSON.stringify(keys);
  const stableKeys = useMemo<string[]>(() => JSON.parse(signature), [signature]);
  const [selected, setSelected] = useState<string | undefined>(() => keys[0]);
  const [manualPause, setPaused] = useState(false);
  const [interacting, setInteracting] = useState(false);
  const [reduced, setReduced] = useState(() => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
  const [hidden, setHidden] = useState(() => document.hidden);
  const selectedIndex = selected === undefined ? -1 : stableKeys.indexOf(selected);
  const index = Math.max(0, selectedIndex);
  const currentKey = stableKeys[index];

  useEffect(() => { setSelected(currentKey); }, [currentKey]);
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const motion = () => setReduced(media?.matches ?? false);
    const visibility = () => setHidden(document.hidden);
    media?.addEventListener("change", motion);
    document.addEventListener("visibilitychange", visibility);
    motion();
    visibility();
    return () => {
      media?.removeEventListener("change", motion);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);

  const move = useCallback((offset: number) => {
    if (!stableKeys.length) return;
    setSelected(previous => {
      const previousIndex = Math.max(0, previous === undefined ? -1 : stableKeys.indexOf(previous));
      return stableKeys[(previousIndex + offset + stableKeys.length) % stableKeys.length];
    });
  }, [stableKeys]);
  const next = useCallback(() => move(1), [move]);
  const previous = useCallback(() => move(-1), [move]);
  const paused = manualPause || reduced;
  useEffect(() => {
    if (paused || interacting || hidden || stableKeys.length < 2) return;
    const timer = window.setTimeout(next, 12_000);
    return () => window.clearTimeout(timer);
  }, [paused, interacting, hidden, stableKeys, currentKey, next]);

  return {index, paused, reduced, setPaused, next, previous, setInteracting};
}
