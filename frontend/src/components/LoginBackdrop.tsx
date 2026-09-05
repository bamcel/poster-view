import { useEffect, useState, type CSSProperties } from "react";
import type { LoginBackdropManifest } from "../api/client";

function shuffled<T>(values: T[]): T[] {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const random = crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;
    const swap = Math.floor(random * (index + 1));
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
}

export default function LoginBackdrop() {
  const [rows, setRows] = useState<string[][]>([]);
  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    let stopped = false;
    let loaded = false;
    const load = async () => {
      try {
        const response = await fetch("/api/login-backdrop", { signal: controller.signal, cache: "no-store" });
        if (!response.ok) throw new Error("Backdrop unavailable");
        const manifest: LoginBackdropManifest = await response.json();
        if (!stopped && manifest.rows.length > 0) {
          loaded = true;
          setRows((current) => current.length > 0 ? current : shuffled(manifest.rows).map((row) => shuffled(row.posters)));
        }
      } catch { /* The themed base remains while no cache is available. */ }
      if (!stopped) timer = window.setTimeout(load, loaded ? 300_000 : 3_000);
    };
    void load();
    return () => {
      stopped = true;
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, []);

  if (rows.length === 0) return null;
  return <div className="login-backdrop" aria-hidden="true">
    <div className="login-backdrop-rows">
      {rows.map((posters, rowIndex) => {
        const segment = Array.from({ length: Math.max(1, Math.ceil(24 / posters.length)) }, () => posters).flat();
        const style = { "--backdrop-duration": `${Math.max(52.5, posters.length * 6.25)}s` } as CSSProperties;
        return <div key={rowIndex} className={`login-backdrop-row ${rowIndex % 2 ? "login-backdrop-row-reverse" : ""}`} style={style}>
          {[0, 1].map((copy) => <div className="login-backdrop-segment" key={copy}>
            {segment.map((poster, index) => <img key={`${poster}-${index}`} src={`/api/login-backdrop/${encodeURIComponent(poster)}`} alt="" loading="eager" decoding="async" />)}
          </div>)}
        </div>;
      })}
    </div>
    <div className="login-backdrop-shade" />
  </div>;
}
