import { Loader2 } from "lucide-react";
import type { NativeScanStatus } from "../api/nativeLibraries";

const phases: Record<string, string> = {discovering: "Discovering files", inspecting: "Inspecting media files", reading: "Reading local metadata and media info", metadata: "Fetching missing metadata and artwork", saving: "Saving metadata and artwork"};
export default function NativeScanProgress({status, compact = false}: {status: NativeScanStatus; compact?: boolean}) {
  const busy = status.status === "scanning";
  const progress = status.progress;
  const percent = progress?.total ? Math.min(100, Math.floor(progress.processed / progress.total * 100)) : undefined;
  return <div className={`${compact ? "space-y-1" : "space-y-2"} min-w-0 text-xs text-muted`} title={compact ? progress?.current : undefined}>
    <p role="status" className="flex items-center gap-2">{busy && <Loader2 aria-hidden="true" className="size-3.5 shrink-0 animate-spin text-accent" />}{busy ? phases[progress?.phase ?? ""] ?? "Starting scan…" : status.status.replaceAll("_", " ")} · {status.count} items</p>
    {busy && progress && <>
      <p>{progress.total !== null ? `${progress.processed} / ${progress.total} ${progress.phase === "metadata" ? "items" : "files"} processed${percent !== undefined ? ` · ${percent}%` : ""}` : progress.phase === "discovering" ? `${progress.processed} files found` : "Writing library changes…"}</p>
      <div role="progressbar" aria-label={phases[progress.phase] ?? "Library scan"} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="h-1.5 overflow-hidden rounded-full bg-base">
        <div className={`h-full rounded-full bg-accent transition-all ${percent === undefined ? "w-1/3 animate-pulse" : ""}`} style={percent === undefined ? undefined : {width: `${percent}%`}} />
      </div>
      {!compact && progress.current && <p className="truncate" title={`/media/${progress.current}`}>/media/{progress.current}</p>}
    </>}
  </div>;
}
