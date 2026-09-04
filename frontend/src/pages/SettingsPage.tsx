// Settings: manage media servers (add/edit/test/delete) and ThePosterDB login.

import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Plus,
  Trash2,
  Pencil,
  PlugZap,
  Star,
  Loader2,
  CheckCircle2,
  XCircle,
  KeyRound,
  Image as ImageIcon,
  Server as ServerIcon,
  Database,
  Palette,
  HardDrive,
} from "lucide-react";
import { api, type ServerInput } from "../api/client";
import { useToast } from "../lib/toast";
import { ServerTypeBadge } from "../components/ui";
import type { ConnectionTest, Server, ServerType } from "../types";
import { applyTheme, THEMES } from "../lib/theme";
import SecuritySection from "../components/SecuritySection";

const BLANK: ServerInput = {
  name: "",
  type: "emby",
  base_url: "",
  token: "",
  is_default: false,
};

const URL_PLACEHOLDER: Record<ServerType, string> = {
  plex: "http://localhost:32400",
  jellyfin: "http://localhost:8096",
  emby: "http://localhost:8096",
};

const TOKEN_LABEL: Record<ServerType, string> = {
  plex: "Plex token (X-Plex-Token)",
  jellyfin: "API key",
  emby: "API key",
};

type SettingsTab = "servers" | "sources" | "database" | "appearance" | "security";

const TABS: { id: SettingsTab; label: string; icon: ReactNode }[] = [
  { id: "servers", label: "Server Setup", icon: <ServerIcon className="size-4" /> },
  { id: "sources", label: "Artwork Sources", icon: <ImageIcon className="size-4" /> },
  { id: "database", label: "Database", icon: <Database className="size-4" /> },
  { id: "appearance", label: "Appearance", icon: <Palette className="size-4" /> },
  { id: "security", label: "Privacy / Security", icon: <KeyRound className="size-4" /> },
];

export default function SettingsPage() {
  const [tab, setTab] = useState<SettingsTab>("servers");

  return (
    <div className="h-full overflow-y-auto px-4 py-4 sm:px-6 lg:px-8 xl:overflow-hidden">
      <div className="mx-auto flex min-h-full w-full max-w-[110rem] flex-col gap-4 xl:h-full xl:min-h-0">
        <h1 className="text-2xl font-semibold">Settings</h1>

        <div className="flex flex-wrap gap-2 border-b border-border pb-3">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium transition-colors ${
                tab === t.id
                  ? "border-accent bg-surface-2 text-white"
                  : "border-transparent text-muted hover:text-white"
              }`}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1">
          {tab === "servers" && <ServersSection />}
          {tab === "sources" && <ArtworkSourcesSection />}
          {tab === "database" && <DatabaseSection />}
          {tab === "appearance" && <AppearanceSection />}
          {tab === "security" && <SecuritySection />}
        </div>
      </div>
    </div>
  );
}

function AppearanceSection() {
  const [selected, setSelected] = useState(() => document.documentElement.dataset.theme ?? "Gotham");

  const choose = (name: string) => {
    setSelected(applyTheme(name));
  };

  return (
    <section className="h-full rounded-2xl border border-border bg-surface p-4">
      <h2 className="mb-1 flex items-center gap-2 text-lg font-semibold">
        <Palette className="size-5 text-accent" /> Color theme
      </h2>
      <p className="mb-3 text-sm text-faint">
        Choose a shared interface palette. Your selection is saved in this browser.
      </p>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4 2xl:grid-cols-6">
        {THEMES.map((theme) => (
          <button
            key={theme.name}
            type="button"
            onClick={() => choose(theme.name)}
            aria-pressed={selected === theme.name}
            className={`flex min-h-16 items-center gap-3 rounded-xl border p-2.5 text-left transition-colors ${
              selected === theme.name
                ? "border-accent bg-elevated"
                : "border-border bg-surface-2 hover:border-border-strong"
            }`}
          >
            <span
              className="grid size-11 shrink-0 grid-cols-2 overflow-hidden rounded-lg border"
              style={{ borderColor: theme.border }}
              aria-hidden="true"
            >
              <span style={{ background: theme.window }} />
              <span style={{ background: theme.card }} />
              <span style={{ background: theme.sidebar }} />
              <span style={{ background: theme.accent }} />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{theme.name}</span>
              <span className="mt-1 block text-xs text-faint">
                {theme.window.toUpperCase()}
              </span>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Media servers
// ---------------------------------------------------------------------------

function ServersSection() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const serversQ = useQuery({ queryKey: ["servers"], queryFn: api.listServers });

  const [form, setForm] = useState<ServerInput>(BLANK);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ConnectionTest | null>(null);

  const reset = () => {
    setForm(BLANK);
    setEditingId(null);
    setTestResult(null);
  };

  const startEdit = (s: Server) => {
    setEditingId(s.id);
    setForm({ name: s.name, type: s.type, base_url: s.base_url, token: "", is_default: s.is_default });
    setTestResult(null);
  };

  const saveMut = useMutation({
    mutationFn: async () => {
      if (editingId == null) return api.createServer(form);
      return api.updateServer(editingId, form);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["servers"] });
      toast.push("success", editingId == null ? "Server added." : "Server updated.");
      reset();
    },
    onError: (e: Error) => toast.push("error", e.message),
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => api.deleteServer(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["servers"] });
      toast.push("info", "Server removed.");
    },
    onError: (e: Error) => toast.push("error", e.message),
  });

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const r =
        editingId != null && form.token === ""
          ? await api.testServerSaved(editingId)
          : await api.testServerAdhoc(form);
      setTestResult(r);
      toast.push(r.ok ? "success" : "error", r.message);
    } catch (e) {
      toast.push("error", (e as Error).message);
    } finally {
      setTesting(false);
    }
  };

  const canSubmit = form.name.trim() && form.base_url.trim() && (editingId != null || form.token);

  return (
    <section className="h-full rounded-2xl border border-border bg-surface p-4">
      <h2 className="mb-1 text-lg font-semibold">Media servers</h2>
      <p className="mb-3 text-sm text-faint">
        Connect Plex, Jellyfin, or Emby. Tokens are encrypted before they're stored.
      </p>

      {/* Existing servers */}
      <div className="mb-4 max-h-52 space-y-2 overflow-y-auto pr-1 xl:max-h-44">
        {serversQ.data?.length === 0 && (
          <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-faint">
            No servers yet — add one below.
          </p>
        )}
        {serversQ.data?.map((s) => (
          <div
            key={s.id}
            className="flex items-center gap-3 rounded-lg border border-border bg-surface-2 px-4 py-3"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate font-medium">{s.name}</span>
                <ServerTypeBadge type={s.type} />
                {s.is_default && (
                  <span className="flex items-center gap-1 text-xs text-accent">
                    <Star className="size-3 fill-accent" /> default
                  </span>
                )}
              </div>
              <p className="truncate text-xs text-faint">{s.base_url}</p>
            </div>
            <IconBtn title="Edit" onClick={() => startEdit(s)}>
              <Pencil className="size-4" />
            </IconBtn>
            <IconBtn
              title="Delete"
              danger
              onClick={() => {
                if (confirm(`Remove "${s.name}"?`)) deleteMut.mutate(s.id);
              }}
            >
              <Trash2 className="size-4" />
            </IconBtn>
          </div>
        ))}
      </div>

      {/* Add / edit form */}
      <div className="rounded-xl border border-border bg-surface-2 p-4">
        <h3 className="mb-3 text-sm font-semibold">
          {editingId == null ? "Add a server" : "Edit server"}
        </h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Name">
            <input
              className={inputCls}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Living Room Jellyfin"
            />
          </Field>
          <Field label="Type">
            <select
              className={inputCls}
              value={form.type}
              onChange={(e) => setForm({ ...form, type: e.target.value as ServerType })}
            >
              <option value="emby">Emby</option>
              <option value="jellyfin">Jellyfin</option>
              <option value="plex">Plex</option>
            </select>
          </Field>
          <Field label="Server URL">
            <input
              className={inputCls}
              value={form.base_url}
              onChange={(e) => setForm({ ...form, base_url: e.target.value })}
              placeholder={URL_PLACEHOLDER[form.type]}
            />
          </Field>
          <Field label={TOKEN_LABEL[form.type]}>
            <input
              className={inputCls}
              type="password"
              value={form.token}
              onChange={(e) => setForm({ ...form, token: e.target.value })}
              placeholder={editingId != null ? "•••••• (leave blank to keep)" : ""}
            />
          </Field>
        </div>

        <label className="mt-3 flex items-center gap-2 text-sm text-muted">
          <input
            type="checkbox"
            checked={form.is_default}
            onChange={(e) => setForm({ ...form, is_default: e.target.checked })}
            className="size-4 accent-[var(--color-accent)]"
          />
          Use as default server
        </label>

        {testResult && (
          <div
            className={`mt-3 flex items-center gap-2 text-sm ${
              testResult.ok ? "text-accent" : "text-danger"
            }`}
          >
            {testResult.ok ? <CheckCircle2 className="size-4" /> : <XCircle className="size-4" />}
            {testResult.ok
              ? `${testResult.server_name ?? "Connected"}${
                  testResult.version ? ` · v${testResult.version}` : ""
                }`
              : testResult.message}
          </div>
        )}

        <div className="mt-4 flex items-center gap-2">
          <button
            onClick={() => saveMut.mutate()}
            disabled={!canSubmit || saveMut.isPending}
            className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-black transition-colors hover:bg-accent-hover disabled:opacity-50"
          >
            {saveMut.isPending ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
            {editingId == null ? "Add server" : "Save Settings"}
          </button>
          <button
            onClick={test}
            disabled={testing || !form.base_url.trim()}
            className="flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted transition-colors hover:text-white disabled:opacity-50"
          >
            {testing ? <Loader2 className="size-4 animate-spin" /> : <PlugZap className="size-4" />}
            Test connection
          </button>
          {editingId != null && (
            <button onClick={reset} className="px-3 py-2 text-sm text-faint hover:text-white">
              Cancel
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Artwork sources — ThePosterDB login + Fanart.tv/TheTVDB API keys, grouped
// into one card since they're all just "credentials for an artwork source".
// ---------------------------------------------------------------------------

function ArtworkSourcesSection() {
  return (
    <section className="h-full rounded-2xl border border-border bg-surface p-4">
      <h2 className="mb-1 flex items-center gap-2 text-lg font-semibold">
        <ImageIcon className="size-5 text-accent" /> Artwork sources
      </h2>
      <p className="mb-3 text-sm text-faint">
        Accounts and API keys used to search and download posters, backgrounds, banners, and logos.
      </p>

      <div className="grid gap-4 xl:grid-cols-[minmax(15rem,0.55fr)_minmax(0,2fr)]">
        <DefaultArtworkSourceFields />
        <div className="border-t border-border pt-4 xl:border-l xl:border-t-0 xl:pl-4 xl:pt-0">
          <ArtworkCredentialsFields />
        </div>
      </div>

    </section>
  );
}

function DatabaseSection() {
  return (
    <section className="h-full rounded-2xl border border-border bg-surface p-4">
      <h2 className="mb-1 flex items-center gap-2 text-lg font-semibold">
        <Database className="size-5 text-accent" /> Database
      </h2>
      <p className="mb-3 text-sm text-faint">
        Choose which databases PosterView uses, manage cached artwork, and control background preloading.
      </p>
      <div className="grid gap-4 xl:grid-cols-[minmax(15rem,0.65fr)_minmax(0,2fr)]">
        <EnabledArtworkSourcesFields />
        <div className="border-t border-border pt-4 xl:border-l xl:border-t-0 xl:pl-4 xl:pt-0">
          <ArtworkCacheFields />
        </div>
      </div>
    </section>
  );
}

const ARTWORK_DATABASES = [
  { name: "posterdb", label: "ThePosterDB" },
  { name: "fanart", label: "Fanart.tv" },
  { name: "tvdb", label: "TheTVDB" },
  { name: "anilist", label: "AniList" },
  { name: "mediux", label: "MediUX" },
];

function DefaultArtworkSourceFields() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const settingsQ = useQuery({ queryKey: ["artwork-settings"], queryFn: api.getArtworkSettings });
  const enabled = settingsQ.data?.enabled_providers ?? [];
  const saveMut = useMutation({
    mutationFn: (provider: string) => api.setArtworkSettings({ default_provider: provider }),
    onSuccess: (settings) => {
      queryClient.setQueryData(["artwork-settings"], settings);
      toast.push("success", "Default artwork source saved.");
    },
    onError: (e: Error) => {
      queryClient.invalidateQueries({ queryKey: ["artwork-cache"] });
      toast.push("error", e.message);
    },
  });

  return (
    <div>
      <h3 className="mb-1 text-sm font-semibold">Default database lookup</h3>
      <p className="mb-3 text-xs text-faint">This source opens first whenever you select a movie, series, or collection.</p>
      <select
        className={inputCls}
        value={settingsQ.data?.default_provider ?? ""}
        onChange={(event) => saveMut.mutate(event.target.value)}
        disabled={settingsQ.isLoading || saveMut.isPending || enabled.length === 0}
      >
        {ARTWORK_DATABASES.filter((source) => enabled.includes(source.name)).map((source) => (
          <option key={source.name} value={source.name}>{source.label}</option>
        ))}
      </select>
    </div>
  );
}

function EnabledArtworkSourcesFields() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const settingsQ = useQuery({ queryKey: ["artwork-settings"], queryFn: api.getArtworkSettings });
  const toggleMut = useMutation({
    mutationFn: (enabledProviders: string[]) => api.setArtworkSettings({ enabled_providers: enabledProviders }),
    onSuccess: (settings) => {
      queryClient.setQueryData(["artwork-settings"], settings);
      queryClient.invalidateQueries({ queryKey: ["artwork-providers"] });
      queryClient.removeQueries({ queryKey: ["artwork"] });
      queryClient.removeQueries({ queryKey: ["artwork-search"] });
      queryClient.removeQueries({ queryKey: ["posterdb-verify"] });
      queryClient.invalidateQueries({ queryKey: ["artwork-cache"] });
    },
    onError: (e: Error) => toast.push("error", e.message),
  });
  const enabled = settingsQ.data?.enabled_providers ?? [];

  return (
    <div>
      <h3 className="mb-1 text-sm font-semibold">Enabled artwork databases</h3>
      <p className="mb-3 text-xs text-faint">Disabled sources are hidden from artwork searches, excluded from Watchdog, and removed from the local cache.</p>
      <div className="space-y-2">
        {ARTWORK_DATABASES.map((source) => {
          const checked = enabled.includes(source.name);
          return (
            <label key={source.name} className="flex items-center justify-between rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm">
              <span>{source.label}</span>
              <input
                type="checkbox"
                checked={checked}
                disabled={settingsQ.isLoading || toggleMut.isPending}
                onChange={() => toggleMut.mutate(checked ? enabled.filter((name) => name !== source.name) : [...enabled, source.name])}
                className="size-4 accent-[var(--accent)]"
              />
            </label>
          );
        })}
      </div>
    </div>
  );
}

function ArtworkCacheFields() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const cacheQ = useQuery({
    queryKey: ["artwork-cache"],
    queryFn: api.getArtworkCache,
    refetchInterval: (query) => query.state.data?.watchdog_running ? 1500 : false,
  });
  const [maxMb, setMaxMb] = useState(250);
  const [ttlDays, setTtlDays] = useState(30);
  const [watchdogEnabled, setWatchdogEnabled] = useState(false);
  const [watchdogInterval, setWatchdogInterval] = useState(24);

  useEffect(() => {
    if (!cacheQ.data) return;
    setMaxMb(cacheQ.data.max_mb);
    setTtlDays(cacheQ.data.ttl_days);
    setWatchdogEnabled(cacheQ.data.watchdog_enabled);
    setWatchdogInterval(cacheQ.data.watchdog_interval_hours);
  }, [cacheQ.data]);

  const saveMut = useMutation({
    mutationFn: (next: Partial<{ max_mb: number; ttl_days: number; watchdog_enabled: boolean; watchdog_interval_hours: number }>) => api.setArtworkCache({
      max_mb: next.max_mb ?? maxMb,
      ttl_days: next.ttl_days ?? ttlDays,
      watchdog_enabled: next.watchdog_enabled ?? watchdogEnabled,
      watchdog_interval_hours: next.watchdog_interval_hours ?? watchdogInterval,
    }),
    onSuccess: (status) => queryClient.setQueryData(["artwork-cache"], status),
    onError: (e: Error) => {
      queryClient.invalidateQueries({ queryKey: ["artwork-cache"] });
      toast.push("error", e.message);
    },
  });

  const clearMut = useMutation({
    mutationFn: api.clearArtworkCache,
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["artwork-cache"] });
      queryClient.removeQueries({ queryKey: ["artwork"] });
      queryClient.removeQueries({ queryKey: ["artwork-search"] });
      queryClient.removeQueries({ queryKey: ["posterdb-verify"] });
      toast.push("info", `Cleared ${formatBytes(result.cleared_bytes)} of artwork cache.`);
    },
    onError: (e: Error) => toast.push("error", e.message),
  });

  const watchdogMut = useMutation({
    mutationFn: api.runArtworkWatchdog,
    onSuccess: (result) => {
      queryClient.setQueryData(["artwork-cache"], (current: typeof cacheQ.data) => current ? { ...current, watchdog_running: true } : current);
      toast.push("info", result.message);
    },
    onError: (e: Error) => toast.push("error", e.message),
  });

  const used = cacheQ.data?.used_bytes ?? 0;
  const limitBytes = Math.max(1, cacheQ.data?.max_mb ?? maxMb) * 1024 * 1024;
  const percent = Math.min(100, (used / limitBytes) * 100);

  return (
    <div>
      <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold">
        <HardDrive className="size-4 text-accent" /> Artwork cache
      </h3>
      <p className="mb-4 text-xs text-faint">
        Keeps recent search results and thumbnails in the persistent Docker data volume so revisits load quickly.
      </p>

      <div className="mb-4 rounded-lg border border-border bg-surface-2 p-3">
        <div className="mb-2 flex items-center justify-between text-xs">
          <span className="text-muted">{formatBytes(used)} used</span>
          <span className="text-faint">{cacheQ.data?.file_count ?? 0} cached items</span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-base">
          <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${percent}%` }} />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Maximum storage">
          <select className={inputCls} value={maxMb} disabled={saveMut.isPending} onChange={(e) => {
            const value = Number(e.target.value);
            setMaxMb(value);
            saveMut.mutate({ max_mb: value });
          }}>
            <option value={100}>100 MB</option>
            <option value={250}>250 MB</option>
            <option value={500}>500 MB</option>
            <option value={1024}>1 GB</option>
            <option value={2048}>2 GB</option>
          </select>
        </Field>
        <Field label="Remove unused items after">
          <select className={inputCls} value={ttlDays} disabled={saveMut.isPending} onChange={(e) => {
            const value = Number(e.target.value);
            setTtlDays(value);
            saveMut.mutate({ ttl_days: value });
          }}>
            <option value={7}>7 days</option>
            <option value={14}>14 days</option>
            <option value={30}>30 days</option>
            <option value={60}>60 days</option>
            <option value={90}>90 days</option>
          </select>
        </Field>
      </div>

      <div className="mt-5 rounded-xl border border-border bg-surface-2 p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h4 className="text-sm font-semibold">Artwork Watchdog</h4>
            <p className="mt-1 text-xs text-faint">
              Builds the current library once, then caches only newly added movies, series, and collections. Removed titles are cleaned up after a complete library scan.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={watchdogEnabled}
            onClick={() => {
              const enabled = !watchdogEnabled;
              setWatchdogEnabled(enabled);
              saveMut.mutate({ watchdog_enabled: enabled });
            }}
            disabled={saveMut.isPending}
            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${watchdogEnabled ? "bg-accent" : "bg-base"}`}
          >
            <span className={`inline-block size-4 rounded-full bg-white transition-transform ${watchdogEnabled ? "translate-x-6" : "translate-x-1"}`} />
          </button>
        </div>
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Run automatically every">
            <select className={inputCls} value={watchdogInterval} onChange={(e) => {
              const value = Number(e.target.value);
              setWatchdogInterval(value);
              saveMut.mutate({ watchdog_interval_hours: value });
            }} disabled={!watchdogEnabled || saveMut.isPending}>
              <option value={6}>6 hours</option>
              <option value={12}>12 hours</option>
              <option value={24}>24 hours</option>
              <option value={72}>3 days</option>
              <option value={168}>7 days</option>
            </select>
          </Field>
          <div className="flex items-end">
            <button
              type="button"
              onClick={() => watchdogMut.mutate()}
              disabled={watchdogMut.isPending || cacheQ.data?.watchdog_running}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted hover:text-white disabled:opacity-50"
            >
              {(watchdogMut.isPending || cacheQ.data?.watchdog_running) && <Loader2 className="size-4 animate-spin" />}
              Run Watchdog now
            </button>
          </div>
        </div>
        {(cacheQ.data?.watchdog_last_message || cacheQ.data?.watchdog_running) && (
          <div className="mt-3 space-y-2 text-xs text-faint">
            <p>{cacheQ.data?.watchdog_running
              ? `Watchdog is running${cacheQ.data.watchdog_current_title ? `: ${cacheQ.data.watchdog_current_title}` : ""}…`
              : cacheQ.data?.watchdog_last_message}</p>
            {(cacheQ.data?.watchdog_progress_total ?? 0) > 0 && (
              <>
                <div className="h-1.5 overflow-hidden rounded-full bg-base">
                  <div
                    className="h-full rounded-full bg-accent transition-all"
                    style={{ width: `${Math.min(100, (cacheQ.data?.watchdog_progress_current ?? 0) / (cacheQ.data?.watchdog_progress_total ?? 1) * 100)}%` }}
                  />
                </div>
                <p>{cacheQ.data?.watchdog_progress_current} of {cacheQ.data?.watchdog_progress_total} titles</p>
              </>
            )}
          </div>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          onClick={() => {
            if (confirm("Clear all cached artwork results and thumbnails?")) clearMut.mutate();
          }}
          disabled={clearMut.isPending || used === 0}
          className="flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted transition-colors hover:border-danger hover:text-danger disabled:opacity-50"
        >
          {clearMut.isPending ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
          Clear cache
        </button>
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function ArtworkCredentialsFields() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const statusQ = useQuery({ queryKey: ["posterdb-status"], queryFn: api.posterdbStatus });
  const settingsQ = useQuery({ queryKey: ["artwork-settings"], queryFn: api.getArtworkSettings });

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fanart, setFanart] = useState("");
  const [tvdbKey, setTvdbKey] = useState("");
  const [tvdbPin, setTvdbPin] = useState("");
  const posterdbChanged = Boolean(password) || email.trim() !== (statusQ.data?.email ?? "");
  const credentialsDirty = posterdbChanged || Boolean(fanart || tvdbKey || tvdbPin);

  useEffect(() => {
    if (statusQ.data?.email) setEmail(statusQ.data.email);
  }, [statusQ.data?.email]);

  const saveMut = useMutation({
    mutationFn: async () => {
      if (posterdbChanged && email.trim()) await api.setPosterdbCredentials(email.trim(), password);
      return api.setArtworkSettings({
        fanart_api_key: fanart || undefined,
        tvdb_api_key: tvdbKey || undefined,
        tvdb_pin: tvdbPin || undefined,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["posterdb-status"] });
      queryClient.invalidateQueries({ queryKey: ["artwork-settings"] });
      queryClient.invalidateQueries({ queryKey: ["artwork-providers"] });
      setPassword("");
      setFanart("");
      setTvdbKey("");
      setTvdbPin("");
      toast.push("success", "Artwork source settings saved.");
    },
    onError: (e: Error) => toast.push("error", e.message),
  });

  const loginMut = useMutation({
    mutationFn: api.posterdbLogin,
    onSuccess: (s) => {
      queryClient.invalidateQueries({ queryKey: ["posterdb-status"] });
      toast.push(s.logged_in ? "success" : "error", s.message || (s.logged_in ? "Logged in." : "Login failed."));
    },
    onError: (e: Error) => toast.push("error", e.message),
  });

  const configured = statusQ.data?.configured;

  return (
    <div>
      <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <KeyRound className="size-4 text-accent" /> ThePosterDB
      </h3>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field
          label={
            <>
              Email / username{" "}
              <a href="https://theposterdb.com/register" target="_blank" rel="noreferrer" className="text-xs text-muted hover:text-white">
                (create account ↗)
              </a>
            </>
          }
        >
          <input
            className={inputCls}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
          />
        </Field>
        <Field label="Password">
          <input
            className={inputCls}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={configured ? "••••••" : ""}
          />
        </Field>
      </div>

      <div className="mt-4 flex items-center gap-2">
        <button
          onClick={() => loginMut.mutate()}
          disabled={loginMut.isPending || !configured}
          className="flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted transition-colors hover:text-white disabled:opacity-50"
        >
          {loginMut.isPending ? <Loader2 className="size-4 animate-spin" /> : <PlugZap className="size-4" />}
          Test login
        </button>
        {statusQ.data?.logged_in && (
          <span className="flex items-center gap-1 text-sm text-accent">
            <CheckCircle2 className="size-4" /> Logged in
          </span>
        )}
      </div>

      <div className="mt-6 border-t border-border pt-5">
        <FanartTvdbFields
          fanart={fanart}
          setFanart={setFanart}
          tvdbKey={tvdbKey}
          setTvdbKey={setTvdbKey}
          tvdbPin={tvdbPin}
          setTvdbPin={setTvdbPin}
          configured={settingsQ.data}
        />
      </div>

      <div className="mt-6 border-t border-border pt-5">
        <button
          onClick={() => saveMut.mutate()}
          disabled={saveMut.isPending || !credentialsDirty}
          className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-black transition-colors hover:bg-accent-hover disabled:opacity-50"
        >
          {saveMut.isPending && <Loader2 className="size-4 animate-spin" />}
          Save Settings
        </button>
      </div>
    </div>
  );
}

function FanartTvdbFields({
  fanart,
  setFanart,
  tvdbKey,
  setTvdbKey,
  tvdbPin,
  setTvdbPin,
  configured: cfg,
}: {
  fanart: string;
  setFanart: (value: string) => void;
  tvdbKey: string;
  setTvdbKey: (value: string) => void;
  tvdbPin: string;
  setTvdbPin: (value: string) => void;
  configured?: { fanart_configured: boolean; tvdb_configured: boolean };
}) {
  const toast = useToast();

  const fanartTestMut = useMutation({
    mutationFn: () => api.testArtworkProvider({ provider: "fanart", fanart_api_key: fanart }),
    onSuccess: (result) => toast.push(result.ok ? "success" : "error", result.message),
    onError: (e: Error) => toast.push("error", e.message),
  });

  const tvdbTestMut = useMutation({
    mutationFn: () =>
      api.testArtworkProvider({
        provider: "tvdb",
        tvdb_api_key: tvdbKey || undefined,
        tvdb_pin: tvdbPin || undefined,
      }),
    onSuccess: (result) => toast.push(result.ok ? "success" : "error", result.message),
    onError: (e: Error) => toast.push("error", e.message),
  });

  return (
    <div>
      <div>
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <ImageIcon className="size-4 text-accent" /> Fanart.tv
        </h3>
        <Field
          label={
            <>
              Fanart.tv API key{" "}
              {cfg?.fanart_configured && <ConfiguredTag />}{" "}
              <a href="https://fanart.tv/get-an-api-key/" target="_blank" rel="noreferrer" className="text-xs text-muted hover:text-white">
                (create account for free key ↗)
              </a>
            </>
          }
        >
          <input
            className={inputCls}
            type="password"
            value={fanart}
            onChange={(e) => setFanart(e.target.value)}
            placeholder={cfg?.fanart_configured ? "••••••" : "your Fanart.tv personal API key"}
          />
        </Field>
        <button
          onClick={() => fanartTestMut.mutate()}
          disabled={fanartTestMut.isPending || (!fanart && !cfg?.fanart_configured)}
          className="mt-3 flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted transition-colors hover:text-white disabled:opacity-50"
        >
          {fanartTestMut.isPending ? <Loader2 className="size-4 animate-spin" /> : <PlugZap className="size-4" />}
          Test API
        </button>
      </div>

      <div className="mt-6 border-t border-border pt-5">
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <ImageIcon className="size-4 text-accent" /> TheTVDB
        </h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field
            label={
              <>
                TheTVDB API key{" "}
                {cfg?.tvdb_configured && <ConfiguredTag />}{" "}
                <a href="https://thetvdb.com/dashboard/account/apikey" target="_blank" rel="noreferrer" className="text-xs text-muted hover:text-white">
                  (create account for free key ↗)
                </a>
              </>
            }
          >
            <input
              className={inputCls}
              type="password"
              value={tvdbKey}
              onChange={(e) => setTvdbKey(e.target.value)}
              placeholder={cfg?.tvdb_configured ? "••••••" : "TheTVDB v4 API key"}
            />
          </Field>
          <Field label="TheTVDB subscriber PIN (optional)">
            <input
              className={inputCls}
              value={tvdbPin}
              onChange={(e) => setTvdbPin(e.target.value)}
              placeholder="only for user-supported keys"
            />
          </Field>
        </div>
        <button
          onClick={() => tvdbTestMut.mutate()}
          disabled={tvdbTestMut.isPending || (!tvdbKey && !cfg?.tvdb_configured)}
          className="mt-3 flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted transition-colors hover:text-white disabled:opacity-50"
        >
          {tvdbTestMut.isPending ? <Loader2 className="size-4 animate-spin" /> : <PlugZap className="size-4" />}
          Test API
        </button>
      </div>
    </div>
  );
}

function ConfiguredTag() {
  return (
    <span className="ml-1 inline-flex items-center gap-1 text-xs text-accent">
      <CheckCircle2 className="size-3" /> set
    </span>
  );
}

// ---------------------------------------------------------------------------
// Small form helpers
// ---------------------------------------------------------------------------

const inputCls =
  "w-full rounded-lg border border-border bg-input px-3 py-2 text-sm outline-none transition-colors hover:bg-input-hover focus:border-accent";

function Field({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-muted">{label}</span>
      {children}
    </label>
  );
}

function IconBtn({
  children,
  onClick,
  title,
  danger,
}: {
  children: ReactNode;
  onClick: () => void;
  title: string;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`grid size-9 place-items-center rounded-lg border border-border transition-colors ${
        danger ? "text-muted hover:border-danger hover:text-danger" : "text-muted hover:text-white"
      }`}
    >
      {children}
    </button>
  );
}
