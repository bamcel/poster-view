import {useQueries, useQuery} from "@tanstack/react-query";
import {Activity, CheckCircle2, Loader2, TriangleAlert} from "lucide-react";
import {Link} from "react-router-dom";
import {useEffect, useRef, useState} from "react";
import {apiRequest} from "../api/client";
import {nativeLibraries, type NativeLibrary} from "../api/nativeLibraries";
import type {MaintenanceTask} from "./ScheduledTasks";
import NativeScanProgress from "./NativeScanProgress";

export default function ActivityStatus({libraries}: {libraries: NativeLibrary[]}) {
  const scans = useQueries({queries: libraries.map(library => ({
    queryKey: ["native-scan", library.id],
    queryFn: () => nativeLibraries.status(library.id),
    refetchInterval: 3000,
  }))});
  const tasks = useQuery({queryKey: ["scheduled-tasks"], queryFn: () => apiRequest<MaintenanceTask[]>("/tasks"), refetchInterval: 3000});
  const observedScans = useRef(new Set<string>());
  const [completed, setCompleted] = useState<{name: string; count: number} | null>(null);
  useEffect(() => {
    scans.forEach((scan, index) => {
      const library = libraries[index];
      if(scan.data?.status === "scanning") observedScans.current.add(library.id);
      else if(scan.data && observedScans.current.delete(library.id) && scan.data.status === "complete") setCompleted({name: library.name, count: scan.data.count});
    });
  }, [scans, libraries]);
  const active = scans.flatMap((scan, index) => scan.data?.status === "scanning" ? [{library: libraries[index], status: scan.data}] : []);
  const running = tasks.data?.filter(task => task.running) ?? [];
  const latest = tasks.data?.filter(task => task.last_run > 0).sort((a, b) => b.last_run - a.last_run)[0];
  const notices = scans.flatMap((scan, index) => scan.data && ["failed", "interrupted", "needs_review"].includes(scan.data.status) ? [{library: libraries[index], status: scan.data}] : []);
  const busy = active.length + running.length > 0;
  const unavailable = tasks.isError || scans.some(scan => scan.isError);
  const loading = tasks.isPending || scans.some(scan => scan.isPending);
  return <section aria-label="Activity status" className="rounded-xl bg-window p-5 text-sm">
    <h2 className="mb-4 flex items-center gap-2 text-lg font-semibold"><Activity aria-hidden="true" className="size-5"/>Activity status</h2>
    <div className="max-h-64 space-y-3 overflow-y-auto" aria-live="polite">
      {active.map(({library, status}) => <Link key={library.id} to={`/media/${encodeURIComponent(library.id)}`} className="block space-y-1.5">
        <p className="truncate font-medium text-accent">{library.name} · Scanning</p>
        <NativeScanProgress status={{...status, show_progress: true}} compact/>
        {status.progress?.current && <p className="truncate text-faint" title={status.progress.current}>{status.progress.current}</p>}
        {status.manual_queued && <p className="text-muted">Manual scan queued</p>}
      </Link>)}
      {running.map(task => <Link key={task.id} to="/settings/tasks" className="flex items-center gap-2 text-accent"><Loader2 aria-hidden="true" className="size-3.5 shrink-0 animate-spin"/>{task.title} · Running</Link>)}
      {!busy && <p className="flex items-center gap-2 text-muted"><CheckCircle2 aria-hidden="true" className="size-3.5 shrink-0"/>{unavailable ? "Activity status unavailable" : loading ? "Checking activity…" : "No active tasks"}</p>}
      {!busy && completed && <p className="text-emerald-300">{completed.name} · Scan completed<span className="mt-1 block text-muted">{completed.count} items</span></p>}
      {notices.map(({library, status}) => <Link key={library.id} to="/settings/libraries" className="block text-amber-200"><span className="flex items-center gap-2"><TriangleAlert aria-hidden="true" className="size-3.5 shrink-0"/><span>{library.name} · {status.status.replaceAll("_", " ")}</span></span>{status.warnings[0] && <p className="mt-1 line-clamp-2 text-muted" title={status.warnings[0]}>{status.warnings[0]}</p>}</Link>)}
      {!busy && latest && <Link to="/settings/tasks" className="block border-t border-border pt-2"><p className={`font-medium ${latest.last_result.startsWith("Failed:") ? "text-amber-200" : "text-emerald-300"}`}>{latest.title} · {latest.last_result.startsWith("Failed:") ? "Failed" : "Completed"}</p><p className="mt-1 line-clamp-2 text-muted" title={latest.last_result}>{latest.last_result}</p></Link>}
    </div>
  </section>;
}
