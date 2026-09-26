import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock, Plus, Play, Square, Pencil, Trash2 } from "lucide-react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { tasksApi, type TaskConfig } from "../api/tasks";

const active = (status: string) => ["queued", "running", "stopping"].includes(status);
const date = (value: number | null) => value ? new Date(value * 1000).toLocaleString() : "—";
const label = (value: string) => value.replaceAll("_", " ");
const field = "w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm";
const button = "inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm hover:bg-surface-2 disabled:opacity-40";
const providers = [["anilist", "AniList"], ["mal", "MyAnimeList (Jikan)"], ["tvdb", "TheTVDB"], ["tmdb", "TMDB"]];

export default function ScheduledTasks() {
  const client = useQueryClient();
  const [form, setForm] = useState<TaskConfig | null>(null);
  const [editing, setEditing] = useState<string>();
  const servers = useQuery({ queryKey: ["servers"], queryFn: api.listServers });
  const libraries = useQuery({ queryKey: ["task-libraries", form?.server_id], queryFn: () => api.getLibraries(form!.server_id), enabled: !!form?.server_id });
  const tasks = useQuery({ queryKey: ["scheduled-tasks"], queryFn: tasksApi.list, refetchInterval: q => q.state.data?.some(t => active(t.status)) ? 2000 : 30000 });
  const completed = tasks.data?.map(t => `${t.id}:${t.finished_at}`).join(",");
  useEffect(() => { void client.invalidateQueries({ queryKey: ["series-credits"] }); }, [client, completed]);
  const save = useMutation({ mutationFn: () => tasksApi.save(form!, editing), onSuccess: () => { setForm(null); void client.invalidateQueries({ queryKey: ["scheduled-tasks"] }); } });
  const action = useMutation({ mutationFn: ({ id, action }: { id: string; action: string }) => tasksApi.action(id, action), onSuccess: data => client.setQueryData(["scheduled-tasks"], data) });
  const change = (patch: Partial<TaskConfig>) => setForm(f => f && ({ ...f, ...patch }));
  const error = tasks.error || servers.error || libraries.error || save.error || action.error;
  return <section className="h-full space-y-5 overflow-y-auto pb-6 pr-1">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h2 className="flex items-center gap-2 text-lg font-semibold"><Clock className="size-5 text-accent" />Scheduled Tasks</h2><p className="mt-1 text-sm text-muted">Keep your collection’s cast and crew up to date. Schedules run while PosterView is running.</p></div>
      <button className={button} disabled={!servers.data?.length || !!form} onClick={() => { save.reset(); setEditing(undefined); setForm({ name: "Fetch missing cast & crew", server_id: servers.data![0].id, library_ids: [], kind: "missing_credits", providers: ["anilist"], enabled: false, interval_hours: 24, stale_days: 30 }); }}><Plus className="size-4" />New Task</button>
    </div>
    {error && <p role="alert" className="text-sm text-danger">{error.message}</p>}
    {form && <form className="space-y-4 rounded-xl border border-border bg-surface p-5" onSubmit={e => { e.preventDefault(); save.mutate(); }}>
      <h3 className="font-semibold">{editing ? "Edit task" : "New task"}</h3>
      <div className="grid gap-4 md:grid-cols-2">
        <label className="space-y-1 text-sm">Name<input required maxLength={100} className={field} value={form.name} onChange={e => change({ name: e.target.value })} /></label>
        <label className="space-y-1 text-sm">Task<select className={field} value={form.kind} onChange={e => change({ kind: e.target.value })}><option value="missing_credits">Fetch missing cast & crew</option><option value="refresh_credits">Refresh outdated cast & crew</option></select></label>
        <label className="space-y-1 text-sm">Media server<select className={field} value={form.server_id} onChange={e => change({ server_id: Number(e.target.value), library_ids: [] })}>{servers.data?.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label className="space-y-1 text-sm">Repeat every (hours)<input className={field} type="number" required min={1} max={8760} value={form.interval_hours} onChange={e => change({ interval_hours: Number(e.target.value) })} /></label>
      </div>
      <fieldset><legend className="mb-2 text-sm font-medium">TV libraries</legend><div className="flex flex-wrap gap-4">{libraries.data?.filter(l => l.type === "show").map(l => <label key={l.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.library_ids.includes(l.id)} onChange={e => change({ library_ids: e.target.checked ? [...form.library_ids, l.id] : form.library_ids.filter(id => id !== l.id) })} />{l.title}</label>)}</div>{libraries.isLoading ? <p className="text-sm text-muted">Loading libraries…</p> : libraries.data && !libraries.data.some(l => l.type === "show") && <p className="text-sm text-muted">No TV libraries on this server.</p>}</fieldset>
      <fieldset><legend className="mb-2 text-sm font-medium">Credit providers</legend><div className="flex flex-wrap gap-4">{providers.map(([id, name]) => <label key={id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.providers.includes(id)} onChange={e => change({ providers: e.target.checked ? [...form.providers, id] : form.providers.filter(p => p !== id) })} />{name}</label>)}</div><p className="mt-2 text-xs text-muted">Uses saved matches and linked provider IDs. TMDB and TheTVDB require configured credentials. All available cast languages are saved; your display preferences apply separately.</p></fieldset>
      {form.kind === "refresh_credits" && <label className="block max-w-xs space-y-1 text-sm">Refresh credits older than (days)<input className={field} type="number" required min={1} max={3650} value={form.stale_days} onChange={e => change({ stale_days: Number(e.target.value) })} /></label>}
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.enabled} onChange={e => change({ enabled: e.target.checked })} />Enable recurring schedule</label>
      <p className="text-xs text-muted">The first scheduled run starts after the interval. Use Run Now to start immediately.</p>
      <div className="flex gap-2"><button className={`${button} bg-accent text-black`} disabled={save.isPending || !form.library_ids.length || !form.providers.length}>{save.isPending ? "Saving…" : "Save Task"}</button><button type="button" className={button} disabled={save.isPending} onClick={() => setForm(null)}>Cancel</button></div>
    </form>}
    {tasks.isLoading && <p className="text-muted">Loading tasks…</p>}
    {tasks.data?.length === 0 && !form && <div className="rounded-xl border border-dashed border-border p-8 text-center"><Clock className="mx-auto mb-3 size-8 text-accent" /><h3 className="font-medium">Let your collection look after itself</h3><p className="mt-2 text-sm text-muted">Create a task to fill missing credits or refresh older provider information.</p></div>}
    {tasks.data?.map(task => <article key={task.id} className="space-y-4 rounded-xl border border-border bg-surface p-5">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-semibold">{task.config.name}</h3><p className="mt-1 text-xs text-muted">{servers.data?.find(s => s.id === task.config.server_id)?.name ?? "Media server"} · {task.config.library_ids.length} libraries · {task.config.enabled ? `Every ${task.config.interval_hours} hours` : "Manual only"}</p></div><span className="rounded-full bg-surface-2 px-3 py-1 text-xs capitalize text-accent">{label(task.status)}</span></div>
      <p className="text-sm text-muted">{task.current_title ?? task.message}</p>
      {(active(task.status) || task.total > 0) && <div><progress aria-label={`${task.config.name} progress`} className="h-2 w-full accent-accent" max={Math.max(task.total, 1)} value={task.processed} /><div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted"><span>{task.processed} / {task.total} series</span><span>{task.updated} updated</span><span>{task.skipped} unchanged</span><span>{task.needs_matching} need matching</span><span>{task.failed} failed</span></div></div>}
      <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-xs text-muted">Next: {date(task.next_run)} · Last finished: {date(task.finished_at)}</p><div className="flex gap-2"><button className={button} disabled={action.isPending || task.status === "stopping"} onClick={() => action.mutate({ id: task.id, action: active(task.status) ? "cancel" : "run" })}>{active(task.status) ? <Square className="size-4" /> : <Play className="size-4" />}{active(task.status) ? "Cancel Run" : "Run Now"}</button><button aria-label={`Edit ${task.config.name}`} className={button} disabled={active(task.status) || !!form} onClick={() => { save.reset(); setEditing(task.id); setForm(task.config); }}><Pencil className="size-4" /></button><button aria-label={`Delete ${task.config.name}`} className={button} disabled={active(task.status) || action.isPending} onClick={() => { if (window.confirm(`Delete task “${task.config.name}”? Saved credits will be kept.`)) action.mutate({ id: task.id, action: "delete" }); }}><Trash2 className="size-4" /></button></div></div>
      {task.issues.length > 0 && <details className="text-sm"><summary className="cursor-pointer text-accent">Needs matching & run issues ({task.issues.length}{task.issues.length === 200 ? "+" : ""})</summary><ul className="mt-3 max-h-64 space-y-3 overflow-y-auto">{task.issues.map((issue, i) => <li key={i}><Link className="text-accent hover:underline" to={`/server/${task.config.server_id}/item/${encodeURIComponent(issue.item_id)}`}>{issue.title}</Link><p className="text-xs text-muted">{issue.message}</p></li>)}</ul></details>}
      {task.history.length > 0 && <details className="text-xs text-muted"><summary className="cursor-pointer">Recent runs</summary><ul className="mt-2 space-y-2">{task.history.map((run, i) => <li key={i}>{date(run.finished_at)} · {label(run.status)} · {run.updated} updated · {run.failed} failed · {run.needs_matching} need matching</li>)}</ul></details>}
    </article>)}
  </section>;
}
