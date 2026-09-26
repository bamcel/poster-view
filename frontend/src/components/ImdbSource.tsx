import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Database, ExternalLink, Search } from "lucide-react";
import { imdbApi, type ImdbTitle } from "../api/imdb";
import { tasksApi } from "../api/tasks";
import { Switch } from "./ui";

export function ImdbAttribution() {
  return <p className="text-xs text-faint">Information courtesy of <a className="text-accent hover:underline" href="https://www.imdb.com" target="_blank" rel="noopener noreferrer">IMDb</a>. Used with permission.</p>;
}
function TitleData({ title }: { title: ImdbTitle }) {
  return <div className="space-y-1">
    <a href={`https://www.imdb.com/title/${title.id}/`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 font-medium text-accent">{title.title}{title.year ? ` (${title.year}${title.end_year ? `–${title.end_year}` : ""})` : ""}<ExternalLink className="size-3" /></a>
    <p className="text-xs text-muted">{title.title_type} · {title.id}{title.runtime_minutes != null ? ` · ${title.runtime_minutes} min` : ""}{title.genres.length ? ` · ${title.genres.join(", ")}` : ""}</p>
    {title.original_title !== title.title && <p className="text-xs text-muted">Original title: {title.original_title}</p>}
    {title.rating != null && <p className="text-sm">IMDb {title.rating.toFixed(1)} / 10 <span className="text-xs text-muted">({title.votes?.toLocaleString()} votes)</span></p>}
  </div>;
}
export default function ImdbSource() {
  const client = useQueryClient();
  const status = useQuery({ queryKey: ["imdb-status"], queryFn: imdbApi.status, refetchInterval: 10000 });
  const enable = useMutation({ mutationFn: imdbApi.enable, onSuccess: data => { client.setQueryData(["imdb-status"], data); void client.invalidateQueries({ queryKey: ["imdb-title"] }); void client.invalidateQueries({ queryKey: ["scheduled-tasks"] }); } });
  const refresh = useMutation({ mutationFn: () => tasksApi.action("imdb_refresh", "run"), onSuccess: () => { void client.invalidateQueries({ queryKey: ["scheduled-tasks"] }); } });
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const results = useQuery({ queryKey: ["imdb-title", submitted, status.data?.updated_at], queryFn: () => imdbApi.search(submitted), enabled: !!status.data?.enabled && !!status.data?.ready && submitted.length >= 2 });
  const error = status.error || enable.error || refresh.error || results.error;
  return <section aria-label="IMDb database source" className="mb-5 space-y-3 rounded-xl border border-border p-4">
    <div className="flex items-center justify-between gap-3"><div><h3 className="flex items-center gap-2 font-semibold"><Database className="size-4 text-accent" />IMDb</h3><p className="mt-1 text-sm text-muted">Local title metadata and ratings for movies and TV.</p></div><Switch label="Enable IMDb database source" checked={status.data?.enabled ?? false} disabled={!status.data || enable.isPending} onChange={() => enable.mutate(!status.data?.enabled)} /></div>
    <p className="text-xs text-muted">Optional personal, noncommercial dataset source. Downloads are stored on your PosterView server; allow several GB of free space during refresh. <a href="https://developer.imdb.com/non-commercial-datasets/" target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">Dataset details and terms</a>.</p>
    <p className="text-xs text-muted">{status.data?.ready ? `${status.data.titles.toLocaleString()} titles · ${status.data.ratings.toLocaleString()} ratings · Updated ${new Date(status.data.updated_at! * 1000).toLocaleString()}` : "No local IMDb data yet. Enable the source, then download its datasets."}</p>
    {status.data?.enabled && <div className="flex flex-wrap items-center gap-3"><button disabled={refresh.isPending} className="rounded-lg border border-border px-3 py-2 text-sm hover:bg-surface-2 disabled:opacity-40" onClick={() => refresh.mutate()}>{refresh.isPending ? "Queueing…" : status.data.ready ? "Refresh IMDb Data" : "Download IMDb Data"}</button><Link className="text-sm text-accent hover:underline" to="/settings?tab=tasks">Progress &amp; schedule</Link></div>}
    {refresh.isSuccess && <p role="status" className="text-xs text-accent">Refresh queued. Follow progress or cancel in Scheduled Tasks.</p>}
    {error && <p role="alert" className="text-sm text-danger">{error.message}</p>}
    {status.data?.enabled && status.data.ready && <div className="space-y-3"><form onSubmit={e => { e.preventDefault(); setSubmitted(query.trim()); }} className="flex gap-2"><input aria-label="IMDb title or ID" placeholder="Title starts with… or tt1234567" className="min-w-0 flex-1 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm" minLength={2} maxLength={200} required value={query} onChange={e => setQuery(e.target.value)} /><button aria-label="Search local IMDb data" className="rounded-lg border border-border p-2"><Search className="size-4" /></button></form>{results.isFetching && <p className="text-xs text-muted">Searching local data…</p>}{submitted && results.data?.length === 0 && <p className="text-xs text-muted">No matching titles in the local index.</p>}<ul className="max-h-80 divide-y divide-border overflow-y-auto">{results.data?.map(title => <li key={title.id} className="py-3"><TitleData title={title} /></li>)}</ul></div>}
    <ImdbAttribution />
  </section>;
}

export function ImdbMetadata({ id }: { id: string }) {
  const status = useQuery({ queryKey: ["imdb-status"], queryFn: imdbApi.status, staleTime: 30000 });
  const title = useQuery({ queryKey: ["imdb-title", id, status.data?.updated_at], queryFn: () => imdbApi.search(id), enabled: !!status.data?.enabled && !!status.data.ready });
  if (!status.data?.enabled || !status.data.ready) return null;
  return <section aria-label="IMDb metadata" className="mt-6 space-y-2"><h3 className="text-sm font-semibold text-muted">IMDb</h3>{title.isLoading ? <p className="text-xs text-muted">Loading IMDb data…</p> : title.error ? <p className="text-xs text-danger">IMDb data could not be loaded.</p> : title.data?.[0] ? <TitleData title={title.data[0]} /> : <p className="text-xs text-muted">This IMDb ID is not in the downloaded dataset.</p>}<ImdbAttribution /></section>;
}
