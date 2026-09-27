import { Loader2, PlugZap } from "lucide-react";
import { reportSettingsSave } from "../lib/settingsSaveStatus";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, apiRequest } from "../api/client";
import ProviderConnection, { providerStatus } from "./ProviderConnection";
interface Settings { enabled: boolean; client: string; version: number }
export default function AnidbSettings() {
  const cache = useQueryClient();
  const query = useQuery({ queryKey: ["anidb-settings"], queryFn: () => apiRequest<Settings>("/anidb/settings") });
  const [draft, setDraft] = useState<Settings | null>(null);
  const value = draft ?? query.data ?? { enabled: false, client: "", version: 1 };
  const test = useMutation({ mutationFn: () => api.testArtworkProvider({ provider: "anidb" }) });
  const save = useMutation({
    mutationFn: (next: Settings) => apiRequest<Settings>("/anidb/settings", { method: "PUT", body: JSON.stringify(next) }),
    onMutate: () => reportSettingsSave("saving"),
    onError: () => reportSettingsSave("error"),
    onSuccess: settings => { cache.setQueryData(["anidb-settings"], settings); setDraft(null); test.reset(); reportSettingsSave("saved"); },
  });
  const change = (patch: Partial<Settings>) => { setDraft({ ...value, ...patch }); save.reset(); test.reset(); };
  const autoSave = (next = value) => {
    if (!save.isPending && Number.isInteger(next.version) && next.version > 0 && (!next.enabled || !!next.client.trim()) && JSON.stringify(next) !== JSON.stringify(query.data)) save.mutate(next);
  };
  const input = "mt-1 w-full rounded-lg border border-border bg-input px-3 py-2 text-sm";
  return <ProviderConnection id="anidb" name="AniDB" description="Anime metadata" status={query.isError ? "Configuration unavailable" : save.isPending ? "Saving…" : providerStatus(query.data ? !!query.data.client.trim() : undefined, test.isPending, test.data, test.error)} setupUrl="https://anidb.net/perl-bin/animedb.pl?show=client">
    <form aria-label="AniDB configuration" className="space-y-3" onSubmit={e => { e.preventDefault(); autoSave(); }}>
    <p className="text-xs text-muted">Optional anime metadata source for Find Missing Metadata. Uses confirmed AniDB IDs, preserves existing fields, and caches responses for 30 days.</p>
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={value.enabled} disabled={query.isPending || query.isError || save.isPending} onChange={e => { const next = { ...value, enabled: e.target.checked }; change(next); autoSave(next); }} />Enable AniDB metadata</label>
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="text-xs text-muted">Registered client name<input className={input} value={value.client} disabled={query.isPending || query.isError || save.isPending} onChange={e => change({ client: e.target.value })} onBlur={() => autoSave()} maxLength={64} /></label>
      <label className="text-xs text-muted">Client version<input className={input} onBlur={() => autoSave()} type="number" min={1} step={1} value={value.version} disabled={query.isPending || query.isError || save.isPending} onChange={e => change({ version: Number(e.target.value) })} /></label>
    </div>
    <p className="text-xs text-muted">Use your registered HTTP API client name and version, not your account password.</p>
    <div className="flex gap-2">
      <button type="button" className="flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-muted transition-colors hover:text-white disabled:opacity-50" disabled={!query.data?.enabled || !!draft || save.isPending || test.isPending} onClick={() => test.mutate()}>{test.isPending ? <Loader2 className="size-4 animate-spin" /> : <PlugZap className="size-4" />}Test Connection</button>
    </div>
    <p className="text-xs text-muted">Changes save automatically when you leave a field.</p>
    {save.isPending && <p role="status" className="text-xs text-muted">Saving…</p>}
    {save.isSuccess && <p role="status" className="text-xs text-accent">AniDB settings saved.</p>}
    {(query.error || save.error || test.error) && <p role="alert" className="text-xs text-danger">{(query.error || save.error || test.error)?.message}</p>}
    {test.data && <p role="status" className={`text-xs ${test.data.ok ? "text-accent" : "text-danger"}`}>{test.data.message}</p>}
  </form></ProviderConnection>;
}
