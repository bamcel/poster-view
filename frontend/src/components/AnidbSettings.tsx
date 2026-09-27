import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, apiRequest } from "../api/client";
interface Settings { enabled: boolean; client: string; version: number }
export default function AnidbSettings() {
  const cache = useQueryClient();
  const query = useQuery({ queryKey: ["anidb-settings"], queryFn: () => apiRequest<Settings>("/anidb/settings") });
  const [draft, setDraft] = useState<Settings | null>(null);
  const value = draft ?? query.data ?? { enabled: false, client: "", version: 1 };
  const test = useMutation({ mutationFn: () => api.testArtworkProvider({ provider: "anidb" }) });
  const save = useMutation({
    mutationFn: () => apiRequest<Settings>("/anidb/settings", { method: "PUT", body: JSON.stringify(value) }),
    onSuccess: settings => { cache.setQueryData(["anidb-settings"], settings); setDraft(null); test.reset(); },
  });
  const change = (patch: Partial<Settings>) => { setDraft({ ...value, ...patch }); save.reset(); test.reset(); };
  const input = "mt-1 w-full rounded-lg border border-border bg-input px-3 py-2 text-sm";
  return <form aria-label="AniDB configuration" className="mb-4 space-y-3 rounded-xl border border-border bg-surface-2 p-4" onSubmit={e => { e.preventDefault(); save.mutate(); }}>
    <h3 className="text-sm font-semibold">AniDB</h3>
    <p className="text-xs text-muted">Optional anime metadata source for Find Missing Metadata. Uses confirmed AniDB IDs, preserves existing fields, and caches responses for 30 days.</p>
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={value.enabled} disabled={query.isPending || query.isError || save.isPending} onChange={e => change({ enabled: e.target.checked })} />Enable AniDB metadata</label>
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="text-xs text-muted">Registered client name<input className={input} value={value.client} disabled={query.isPending || query.isError || save.isPending} onChange={e => change({ client: e.target.value })} maxLength={64} /></label>
      <label className="text-xs text-muted">Client version<input className={input} type="number" min={1} step={1} value={value.version} disabled={query.isPending || query.isError || save.isPending} onChange={e => change({ version: Number(e.target.value) })} /></label>
    </div>
    <p className="text-xs text-muted">Use your registered HTTP API client name and version, not your account password. <a className="text-accent underline" href="https://anidb.net/perl-bin/animedb.pl?show=client" target="_blank" rel="noreferrer">AniDB client registration</a></p>
    <div className="flex gap-2">
      <button className="rounded-lg border border-border px-4 py-2 text-sm disabled:opacity-50" disabled={!draft || save.isPending || test.isPending || !Number.isInteger(value.version) || value.version < 1 || (value.enabled && !value.client.trim())}>{save.isPending ? "Saving…" : "Save AniDB settings"}</button>
      <button type="button" className="rounded-lg border border-border px-4 py-2 text-sm disabled:opacity-50" disabled={!query.data?.enabled || !!draft || save.isPending || test.isPending} onClick={() => test.mutate()}>{test.isPending ? "Testing…" : "Test Connection"}</button>
    </div>
    {save.isSuccess && <p role="status" className="text-xs text-accent">AniDB settings saved.</p>}
    {(query.error || save.error || test.error) && <p role="alert" className="text-xs text-danger">{(query.error || save.error || test.error)?.message}</p>}
    {test.data && <p role="status" className={`text-xs ${test.data.ok ? "text-accent" : "text-danger"}`}>{test.data.message}</p>}
  </form>;
}
