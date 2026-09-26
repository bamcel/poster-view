import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CirclePlay, CircleStop, ChevronDown } from "lucide-react";
import { Link } from "react-router-dom";
import { tasksApi, type ScheduledTask, type TaskConfig } from "../api/tasks";

const active = (status: string) => ["queued", "running", "stopping"].includes(status);
const date = (value: number | null) => value ? new Date(value * 1000).toLocaleString() : "Never";
const label = (value: string) => value.replaceAll("_", " ");
const field = "w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm";
const button = "rounded-lg border border-border px-3 py-2 text-sm hover:bg-surface-2 disabled:opacity-40";

export function lastRun(task: ScheduledTask) {
  if (!task.finished_at) return "Not run yet.";
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - task.finished_at);
  const ago = seconds < 60 ? "just now" : seconds < 3600 ? `${Math.floor(seconds / 60)} minutes ago` : seconds < 86400 ? `${Math.floor(seconds / 3600)} hours ago` : `${Math.floor(seconds / 86400)} days ago`;
  const duration = task.started_at == null ? "" : `, taking ${Math.max(0, task.finished_at - task.started_at)} seconds`;
  return `Last ran ${ago}${duration}.`;
}

export default function ScheduledTasks() {
  const client = useQueryClient();
  const tasks = useQuery({ queryKey: ["scheduled-tasks"], queryFn: tasksApi.list, refetchInterval: q => q.state.data?.some(t => active(t.status)) ? 2000 : 30000 });
  const completed = tasks.data?.map(t => `${t.id}:${t.finished_at}`).join(",");
  useEffect(() => { void client.invalidateQueries({ queryKey: ["series-credits"] }); void client.invalidateQueries({ queryKey: ["imdb-status"] }); void client.invalidateQueries({ queryKey: ["imdb-title"] }); }, [client, completed]);
  const action = useMutation({ mutationFn: ({ id, action }: { id: string; action: string }) => tasksApi.action(id, action), onSuccess: data => client.setQueryData(["scheduled-tasks"], data) });
  const error = tasks.error || action.error;
  return <section className="h-full overflow-y-auto pb-6 pr-2">
    <h2 className="mb-2 text-xl font-semibold text-muted">Library</h2>
    <p className="mb-4 text-sm text-muted">Library tasks cover all applicable libraries. Database tasks refresh shared local sources. Schedules run while PosterView is running.</p>
    {error && <p role="alert" className="mb-3 text-sm text-danger">{error.message}</p>}
    {tasks.isLoading && <p className="text-muted">Loading tasks...</p>}
    <ul className="divide-y divide-border border-b border-border">
      {tasks.data?.map(task => <li key={task.id} className="py-4">
        <div className="flex items-center gap-4">
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-semibold">{task.config.name}</h3>
            <p className="mt-0.5 text-sm text-muted">{active(task.status) ? `${label(task.status)}: ${task.current_title ?? task.message}` : lastRun(task)}</p>
            <p className="mt-0.5 text-sm text-muted">{task.config.kind === "imdb_refresh" ? "Downloads IMDb titles and ratings into the local database. Enable IMDb in Settings → Database first." : task.config.kind === "missing_metadata" ? "Fills missing metadata and cast & crew across all movie and TV libraries, preserving existing values." : task.config.kind === "missing_credits" ? "Fetches missing cast and crew for series in all TV libraries." : `Refreshes cast and crew older than ${task.config.stale_days} days in all TV libraries.`}</p>
            {task.finished_at && <p className={`mt-1 text-xs ${task.failed || task.needs_matching || task.status === "failed" ? "text-accent" : "text-muted"}`}>{label(task.status)} &middot; {task.updated} updated &middot; {task.needs_matching} need matching &middot; {task.failed} failed</p>}
          </div>
          <button className="shrink-0 rounded-full p-2 text-muted transition-colors hover:bg-surface-2 hover:text-accent focus-visible:outline focus-visible:outline-accent disabled:opacity-40" aria-label={`${active(task.status) ? "Cancel" : "Run"} ${task.config.name}`} title={active(task.status) ? "Cancel run" : "Run now"} disabled={action.isPending || task.status === "stopping"} onClick={() => action.mutate({ id: task.id, action: active(task.status) ? "cancel" : "run" })}>{active(task.status) ? <CircleStop className="size-6" /> : <CirclePlay className="size-6" />}</button>
        </div>
        {active(task.status) && <div className="mt-3"><progress aria-label={`${task.config.name} progress`} className="h-1.5 w-full accent-accent" max={Math.max(task.total, 1)} value={task.processed} /><p className="mt-1 text-xs text-muted">{task.processed} / {task.total} {task.config.kind === "imdb_refresh" ? "stages" : task.config.kind === "missing_metadata" ? "titles" : "series"}</p></div>}
        <details className="group mt-2 text-sm">
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-xs text-muted hover:text-accent"><ChevronDown className="size-3 transition-transform group-open:rotate-180" />Schedule &amp; details{task.config.enabled ? ` - every ${task.config.interval_hours} hours` : " - manual"}</summary>
          <div className="mt-4 space-y-4 pl-1">
            <Schedule task={task} />
            <p className="text-xs text-muted">{task.config.kind === "imdb_refresh" ? "Refreshes title basics and ratings for local movie/TV lookups. Failed downloads keep the previous index. No cast or crew datasets are imported by this task." : task.config.kind === "missing_metadata" ? "All movie and TV libraries · Uses confirmed provider IDs. Review uncertain matches in Edit Metadata → Provider matching. Stored in PosterView; no NFO or media-server writes." : "All TV libraries · AniList, MyAnimeList (Jikan), and configured TVDB/TMDB providers. Uses linked IDs and saves all available cast languages."}</p>
            <p className="text-xs text-muted">{task.message} Next scheduled run: {task.next_run ? date(task.next_run) : "Disabled"}.</p>
            {task.issues.length > 0 && <div><h4 className="mb-2 font-medium">Matching &amp; run issues</h4><ul className="max-h-64 space-y-2 overflow-y-auto">{task.issues.map((issue, i) => <li key={i}><Link className="text-accent hover:underline" to={`/server/${issue.server_id}/item/${encodeURIComponent(issue.item_id)}`}>{issue.title}</Link><p className="text-xs text-muted">{issue.message}</p></li>)}</ul>{task.issues.length === 200 && <p className="text-xs text-muted">Showing the first 200 issues.</p>}</div>}
            {task.history.length > 0 && <div><h4 className="mb-2 font-medium">Recent runs</h4><ul className="space-y-1 text-xs text-muted">{task.history.map((run, i) => <li key={i}>{date(run.finished_at)} &middot; {label(run.status)} &middot; {run.updated} updated &middot; {run.failed} failed &middot; {run.needs_matching} need matching</li>)}</ul></div>}
          </div>
        </details>
      </li>)}
    </ul>
  </section>;
}

function Schedule({ task }: { task: ScheduledTask }) {
  const client = useQueryClient();
  const [form, setForm] = useState<TaskConfig>(task.config);
  useEffect(() => setForm(task.config), [task.config]);
  const save = useMutation({ mutationFn: () => tasksApi.save(form, task.id), onSuccess: () => { void client.invalidateQueries({ queryKey: ["scheduled-tasks"] }); } });
  return <form className="max-w-xl space-y-3" onSubmit={e => { e.preventDefault(); save.mutate(); }}>
    <fieldset disabled={active(task.status) || save.isPending} className="space-y-3 disabled:opacity-50">
      <label className="flex items-center gap-2"><input type="checkbox" checked={form.enabled} onChange={e => setForm({ ...form, enabled: e.target.checked })} />Enable recurring schedule</label>
      <div className="grid gap-3 sm:grid-cols-2"><label>Repeat every (hours)<input className={field} type="number" min={1} max={8760} required value={form.interval_hours} onChange={e => setForm({ ...form, interval_hours: Number(e.target.value) })} /></label>{task.config.kind === "refresh_credits" && <label>Refresh age (days)<input className={field} type="number" min={1} max={3650} required value={form.stale_days} onChange={e => setForm({ ...form, stale_days: Number(e.target.value) })} /></label>}</div>
      <button className={button}>{save.isPending ? "Saving..." : "Save Schedule"}</button>
    </fieldset>
    {save.error && <p role="alert" className="text-xs text-danger">{save.error.message}</p>}
    {save.isSuccess && <p role="status" className="text-xs text-accent">Schedule saved.</p>}
  </form>;
}
