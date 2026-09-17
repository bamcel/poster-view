import type { ArtworkCacheStatus } from "../types";

function RunTime({ value, empty }: { value?: string | null; empty: string }) {
  if (!value || !Number.isFinite(Date.parse(value))) return <>{empty}</>;
  return <time dateTime={value}>{new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</time>;
}

export default function WatchdogStatus({ status, starting, stopping, error }: {
  status: ArtworkCacheStatus; starting?: boolean; stopping?: boolean; error?: string;
}) {
  const state = error && !status.watchdog_running ? "failed" : stopping || (status.watchdog_running && status.watchdog_cancel_requested) ? "stopping"
    : starting ? "scanning" : status.watchdog_state ?? (status.watchdog_running ? status.watchdog_current_title ? "preloading" : "scanning" : "idle");
  const label = { idle: "Idle", scanning: "Scanning", preloading: "Preloading", stopping: "Stopping", failed: "Failed" }[state];
  const active = ["scanning", "preloading", "stopping"].includes(state);
  const total = status.watchdog_progress_total;
  const current = Math.max(0, Math.min(total, status.watchdog_progress_current));
  return <div className="mt-4 space-y-3 rounded-lg border border-border bg-base/30 p-3 text-xs">
    <div role="status" aria-live="polite" aria-atomic="true" className="space-y-1 break-words">
      <p className={`font-semibold ${state === "failed" ? "text-danger" : "text-accent"}`}>{active ? "Syncing Artwork" : "Sync"}: {label}</p>
      <p className="text-muted">{error?.replace(/Watchdog/gi, "Sync") || (state === "scanning" ? "Checking libraries for new and removed titles."
        : state === "stopping" ? "Cancelling the current request…"
        : state === "preloading" ? `Loading artwork${status.watchdog_current_title ? ` for ${status.watchdog_current_title}` : ""}.`
        : status.watchdog_last_message?.replace(/Watchdog/gi, "Sync") || "Ready to scan this server’s libraries.")}</p>
    </div>
    {active && state !== "scanning" && total > 0 && <div>
      <progress aria-label="Titles preloaded" max={total} value={current} className="h-2 w-full accent-[var(--color-accent)]" />
      <p className="mt-1 text-faint">{current} of {total} titles</p>
    </div>}
    <dl className="grid gap-3 text-muted sm:grid-cols-2">
      <div><dt className="text-faint">Last successful run</dt><dd className="mt-1"><RunTime value={status.watchdog_last_successful_run} empty="No successful run yet" /></dd></div>
      <div><dt className="text-faint">Next scheduled run</dt><dd className="mt-1">{active ? "Calculated when this run finishes" : status.watchdog_next_run
        ? <><RunTime value={status.watchdog_next_run} empty="Not scheduled" /><span className="mt-1 block text-faint">Runs when the scheduler next checks.</span></>
        : state === "failed" ? "Resolve the error and run Sync again" : status.watchdog_enabled ? "Awaiting schedule" : "Automatic Sync is off"}</dd></div>
    </dl>
  </div>;
}
