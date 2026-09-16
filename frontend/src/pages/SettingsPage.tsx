// Settings: manage media servers (add/edit/test/delete) and ThePosterDB login.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
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
  ChevronDown,
} from "lucide-react";
import { api, type ServerInput } from "../api/client";
import { useToast } from "../lib/toast";
import { ServerTypeBadge } from "../components/ui";
import type { ConnectionTest, LibraryVisibility, Server, ServerType } from "../types";
import {
  applyTheme,
  getAllThemes,
  getStoredThemeName,
  getTheme,
  loadCustomThemes,
  parseThemeJson,
  previewTheme,
  removeCustomTheme,
  saveCustomTheme,
  serializeTheme,
  THEME_COLOR_OPTIONS,
  type AppTheme,
  type ThemeColorKey,
} from "../lib/theme";
import SecuritySection from "../components/SecuritySection";
import { reportSettingsSave, type SettingsSaveStatus } from "../lib/settingsSaveStatus";

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
  { id: "sources", label: "Search Providers", icon: <ImageIcon className="size-4" /> },
  { id: "database", label: "Cache Services", icon: <Database className="size-4" /> },
  { id: "appearance", label: "Appearance", icon: <Palette className="size-4" /> },
  { id: "security", label: "Privacy / Security", icon: <KeyRound className="size-4" /> },
];

export default function SettingsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get("tab");
  const tab: SettingsTab = TABS.some((candidate) => candidate.id === requestedTab)
    ? (requestedTab as SettingsTab)
    : "servers";
  const [saveStatus, setSaveStatus] = useState<SettingsSaveStatus>("saved");

  const selectTab = (nextTab: SettingsTab) => {
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      if (nextTab === "servers") next.delete("tab");
      else next.set("tab", nextTab);
      return next;
    }, { replace: true });
  };

  useEffect(() => {
    const update = (event: Event) => setSaveStatus((event as CustomEvent<SettingsSaveStatus>).detail);
    window.addEventListener("posterview:settings-save", update);
    return () => window.removeEventListener("posterview:settings-save", update);
  }, []);

  return (
    <div className="h-full overflow-y-auto px-4 py-4 sm:px-6 lg:px-8 xl:overflow-hidden">
      <div className="mx-auto flex min-h-full w-full max-w-6xl flex-col gap-4 xl:h-full xl:min-h-0">
        <h1 className="text-2xl font-semibold">Settings</h1>

        <div className="flex flex-col gap-2 border-b border-border pb-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          <div className="flex flex-nowrap gap-3 overflow-x-auto px-1 pb-3">{TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => selectTab(t.id)}
              aria-pressed={tab === t.id}
              className={`flex shrink-0 items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium transition-colors ${
                tab === t.id
                  ? "border-accent bg-surface-2 text-white"
                  : "border-transparent text-muted hover:text-white"
              }`}
            >
              {t.icon}
              {t.label}
            </button>
          ))}</div>
          <span role="status" className={`shrink-0 self-end text-xs sm:self-auto ${saveStatus === "error" ? "text-danger" : "text-accent"}`}>
            {saveStatus === "saving" ? "Saving settings…" : saveStatus === "error" ? "Settings could not be saved." : "Settings saved automatically."}
          </span>
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
  const [themes, setThemes] = useState(getAllThemes);
  const [selected, setSelected] = useState(getStoredThemeName);
  const [themeJson, setThemeJson] = useState(() => serializeTheme(getTheme(getStoredThemeName())));
  const [selectedColor, setSelectedColor] = useState<ThemeColorKey>("accent");
  const [customName, setCustomName] = useState("");
  const [message, setMessage] = useState("");

  const choose = (name: string) => {
    const theme = getTheme(name);
    setSelected(applyTheme(theme));
    setThemeJson(serializeTheme(theme));
    setCustomName(loadCustomThemes().some((candidate) => candidate.name === name) ? name : "");
    setMessage(`Theme applied: ${name}`);
    reportSettingsSave("saved");
  };

  const reload = () => {
    const theme = getTheme(selected);
    applyTheme(theme);
    setThemeJson(serializeTheme(theme));
    setMessage(`Theme reloaded: ${theme.name}`);
  };

  const updateColor = (color: string) => {
    try {
      const theme = parseThemeJson(themeJson);
      theme[selectedColor] = color.toUpperCase();
      setThemeJson(serializeTheme(theme));
      previewTheme(theme);
      setMessage("Previewing unsaved changes");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Theme JSON is invalid.");
    }
  };

  const save = () => {
    try {
      const theme = parseThemeJson(themeJson);
      theme.name = customName.trim() || theme.name;
      saveCustomTheme(theme);
      setThemes(getAllThemes());
      setSelected(theme.name);
      setCustomName(theme.name);
      setThemeJson(serializeTheme(theme));
      setMessage(`Custom theme saved: ${theme.name}`);
      reportSettingsSave("saved");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Theme JSON is invalid.");
      reportSettingsSave("error");
    }
  };

  const selectedIsCustom = loadCustomThemes().some((theme) => theme.name === selected);
  const remove = () => {
    if (!selectedIsCustom) return;
    const removedName = selected;
    removeCustomTheme(removedName);
    const fallback = getTheme(getStoredThemeName());
    setThemes(getAllThemes());
    setSelected(fallback.name);
    setCustomName("");
    setThemeJson(serializeTheme(fallback));
    setMessage(`Custom theme removed: ${removedName}`);
    reportSettingsSave("saved");
  };

  let selectedColorValue = "#000000";
  try {
    selectedColorValue = parseThemeJson(themeJson)[selectedColor];
  } catch {
    selectedColorValue = getTheme(selected)[selectedColor];
  }

  return (
    <section className="h-full min-h-0 overflow-y-auto rounded-2xl border border-border bg-surface p-4">
      <div className="grid min-h-full gap-4 xl:grid-cols-2">
      <div className="flex min-h-[32rem] flex-col xl:min-h-0 xl:pr-2">
        <h2 className="text-lg font-semibold">Theme JSON</h2>
        <p className="mt-1 text-sm text-faint">Edit or paste a complete PosterView theme definition.</p>
        <label className="mt-4 flex min-h-0 flex-1 flex-col text-xs font-semibold text-muted">
          Theme JSON
          <textarea
            value={themeJson}
            onChange={(event) => setThemeJson(event.target.value)}
            spellCheck={false}
            style={{ fontSize: "0.75rem", lineHeight: "1rem" }}
            className="mt-2 min-h-80 w-full flex-1 resize-none rounded-lg border border-border bg-input p-4 font-mono font-normal text-white outline-none focus:border-accent xl:min-h-0"
          />
        </label>
      </div>

      <div className="min-h-0 border-t border-border pt-4 xl:border-l xl:border-t-0 xl:pl-4 xl:pt-0">
        <div>
          <h2 className="text-lg font-semibold">Theme</h2>
          <p className="mt-1 text-sm text-faint">Select a palette or preview an individual color.</p>
          <div className="mt-4 flex items-end gap-2">
            <ThemePicker themes={themes} selected={selected} onSelect={choose} />
            <button type="button" onClick={reload} className="h-10 shrink-0 rounded-lg border border-border bg-button px-4 text-sm font-medium text-muted hover:bg-button-hover hover:text-white">
              Reload theme
            </button>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="text-xs font-semibold text-muted">
              Color label
              <select value={selectedColor} onChange={(event) => setSelectedColor(event.target.value as ThemeColorKey)} className={`${compactInputCls} mt-2`}>
                {THEME_COLOR_OPTIONS.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
              </select>
            </label>
            <label className="text-xs font-semibold text-muted">
              {THEME_COLOR_OPTIONS.find((option) => option.key === selectedColor)?.label}
              <span className="mt-2 flex h-10 items-center gap-3 rounded-lg border border-border bg-input px-3">
                <input aria-label={`Choose ${THEME_COLOR_OPTIONS.find((option) => option.key === selectedColor)?.label} color`} type="color" value={selectedColorValue} onChange={(event) => updateColor(event.target.value)} className="h-7 w-9 cursor-pointer border-0 bg-transparent p-0" />
                <span className="font-mono text-xs text-white">{selectedColorValue.toUpperCase()}</span>
              </span>
            </label>
          </div>
          <p className="mt-2 text-xs text-faint">Color changes preview immediately. Save them as a custom theme to keep them.</p>
        </div>

        <div className="mt-4 border-t border-border pt-4">
          <h2 className="text-lg font-semibold">Custom theme</h2>
          <p className="mt-1 text-sm text-faint">Save the edited JSON under a unique name or remove a selected custom theme.</p>
          <label className="mt-4 block text-xs font-semibold text-muted">
            Custom theme name
            <input value={customName} onChange={(event) => setCustomName(event.target.value)} placeholder="My theme" className={`${compactInputCls} mt-2`} />
          </label>
          <button type="button" onClick={save} className="mt-4 h-10 w-full rounded-lg bg-accent px-4 text-sm font-semibold text-white hover:bg-accent-hover">Save custom theme</button>
          <button type="button" onClick={remove} disabled={!selectedIsCustom} className="mt-2 h-10 w-full rounded-lg border border-border bg-button px-4 text-sm font-medium text-muted hover:bg-button-hover hover:text-white disabled:cursor-not-allowed disabled:text-disabled">Remove custom theme</button>
          {message && <p role="status" className="mt-3 text-xs text-faint">{message}</p>}
        </div>
      </div>
      </div>
    </section>
  );
}

function ThemePicker({ themes, selected, onSelect }: { themes: AppTheme[]; selected: string; onSelect: (name: string) => void }) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const selectedTheme = themes.find((theme) => theme.name === selected) ?? themes[0];
  return (
    <div className="min-w-0 flex-1 text-xs font-semibold text-muted">
      <span>Theme</span>
      <details ref={detailsRef} className="group relative mt-2">
        <summary aria-label="Select theme" className="flex h-10 cursor-pointer list-none items-center gap-2 rounded-lg border border-border bg-input px-3 text-sm font-normal text-white outline-none marker:hidden focus-visible:border-accent">
          <ThemePaletteIcon theme={selectedTheme} />
          <span className="min-w-0 flex-1 truncate">{selectedTheme.name}</span>
          <span className="text-faint transition-transform group-open:rotate-180">⌄</span>
        </summary>
        <div className="absolute z-30 mt-1 max-h-72 w-full overflow-y-auto rounded-lg border border-border bg-sidebar p-1 shadow-2xl">
          {themes.map((theme) => (
            <button key={theme.name} type="button" onClick={() => { onSelect(theme.name); detailsRef.current?.removeAttribute("open"); }} className={`flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-surface-2 ${theme.name === selected ? "text-accent" : "text-white"}`}>
              <ThemePaletteIcon theme={theme} />
              <span className="truncate">{theme.name}</span>
            </button>
          ))}
        </div>
      </details>
    </div>
  );
}

function ThemePaletteIcon({ theme }: { theme: AppTheme }) {
  return (
    <span className="grid size-6 shrink-0 grid-cols-2 overflow-hidden rounded-md border" style={{ borderColor: theme.border }} aria-hidden="true">
      <span style={{ background: theme.window }} />
      <span style={{ background: theme.card }} />
      <span style={{ background: theme.sidebar }} />
      <span style={{ background: theme.accent }} />
    </span>
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
  const [formOpen, setFormOpen] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ConnectionTest | null>(null);

  const reset = () => {
    setForm(BLANK);
    setEditingId(null);
    setTestResult(null);
    setFormOpen(false);
  };

  const startAdd = () => {
    setForm(BLANK);
    setEditingId(null);
    setTestResult(null);
    setFormOpen(true);
  };

  const startEdit = (s: Server) => {
    setEditingId(s.id);
    setForm({ name: s.name, type: s.type, base_url: s.base_url, token: "", is_default: s.is_default });
    setTestResult(null);
    setFormOpen(true);
  };

  const saveMut = useMutation({
    mutationFn: async () => {
      if (editingId == null) return api.createServer(form);
      return api.updateServer(editingId, form);
    },
    onMutate: () => reportSettingsSave("saving"),
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
    <section className="h-full overflow-y-auto rounded-2xl border border-border bg-surface p-4">
      <h2 className="mb-1 flex items-center gap-2 text-lg font-semibold">
        <ServerIcon className="size-5 text-accent" /> Server setup
      </h2>
      <p className="mb-3 text-sm text-faint">
        Connect your media servers and choose which artwork databases PosterView can search.
      </p>

      <div>
        <div className="rounded-xl border border-border bg-surface-2 p-3">
          <h3 className="mb-1 text-sm font-semibold">Media servers</h3>
          <p className="mb-3 text-xs text-faint">
            Connect Plex, Jellyfin, or Emby. Tokens are encrypted before they're stored.
          </p>

          {/* Existing servers */}
          <div className="mb-3 divide-y divide-border">
            {serversQ.data?.length === 0 && (
              <p className="rounded-lg border border-dashed border-border px-4 py-4 text-center text-sm text-faint">
                No servers yet — add one below.
              </p>
            )}
            {serversQ.data?.map((s) => (
              <ServerCard
                key={s.id}
                server={s}
                onEdit={() => startEdit(s)}
                onDelete={() => {
                  if (confirm(`Remove "${s.name}"?`)) deleteMut.mutate(s.id);
                }}
              />
            ))}
          </div>

          {/* Add / edit form */}
          <div className="px-1 pt-1">
            {!formOpen ? (
              <button
                type="button"
                onClick={startAdd}
                className="flex items-center gap-2 rounded-lg border border-border bg-button px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-button-hover"
              >
                <Plus className="size-4 text-accent" /> Add server
              </button>
            ) : (
              <>
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

            <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            onClick={() => saveMut.mutate()}
            disabled={!canSubmit || saveMut.isPending}
            className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-black transition-colors hover:bg-accent-hover disabled:opacity-50"
          >
            {saveMut.isPending ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
            {editingId == null ? "Add server" : "Update server"}
          </button>
          <button
            onClick={test}
            disabled={testing || !form.base_url.trim()}
            className="flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted transition-colors hover:text-white disabled:opacity-50"
          >
            {testing ? <Loader2 className="size-4 animate-spin" /> : <PlugZap className="size-4" />}
            Test connection
          </button>
            <button onClick={reset} className="px-3 py-2 text-sm text-faint hover:text-white">
              Cancel
            </button>
            </div>
              </>
            )}
          </div>
        </div>

        <div className="mt-3 rounded-xl border border-border bg-surface-2 p-3">
          <EnabledArtworkSourcesFields />
        </div>
      </div>
    </section>
  );
}

function ServerCard({
  server,
  onEdit,
  onDelete,
}: {
  server: Server;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const visibilityQ = useQuery({
    queryKey: ["library-visibility", server.id],
    queryFn: () => api.getLibraryVisibility(server.id),
  });
  const visibilityMut = useMutation({
    mutationFn: (next: LibraryVisibility) =>
      api.setLibraryVisibility(
        server.id,
        next.libraries.filter((library) => !library.visible).map((library) => library.id),
      ),
    onMutate: async (next) => {
      reportSettingsSave("saving");
      await queryClient.cancelQueries({ queryKey: ["library-visibility", server.id] });
      const previous = queryClient.getQueryData<LibraryVisibility>(["library-visibility", server.id]);
      queryClient.setQueryData(["library-visibility", server.id], next);
      return { previous };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["libraries", server.id] });
      reportSettingsSave("saved");
    },
    onError: (error: Error, _next, context) => {
      if (context?.previous) {
        queryClient.setQueryData(["library-visibility", server.id], context.previous);
      }
      reportSettingsSave("error");
      toast.push("error", error.message);
    },
  });

  const toggleLibrary = (libraryId: string) => {
    const current = visibilityQ.data;
    if (!current) return;
    visibilityMut.mutate({
      libraries: current.libraries.map((library) =>
        library.id === libraryId ? { ...library, visible: !library.visible } : library,
      ),
    });
  };

  return (
    <div className="px-1 py-3 first:pt-0 last:pb-0">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">{server.name}</span>
            <ServerTypeBadge type={server.type} />
            {server.is_default && (
              <span className="flex items-center gap-1 text-xs text-accent">
                <Star className="size-3 fill-accent" /> default
              </span>
            )}
          </div>
          <p className="truncate text-xs text-faint">{server.base_url}</p>
        </div>
        <IconBtn title="Edit" onClick={onEdit}>
          <Pencil className="size-4" />
        </IconBtn>
        <IconBtn title="Delete" danger onClick={onDelete}>
          <Trash2 className="size-4" />
        </IconBtn>
      </div>

      <details className="group mt-3 overflow-hidden rounded-lg border border-border bg-window">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-sm text-muted transition-colors hover:text-white [&::-webkit-details-marker]:hidden">
          <span className="min-w-0">
            <span className="block font-medium text-white">Libraries shown on the Libraries page</span>
            <span className="block text-xs text-faint">
              {visibilityQ.isLoading
                ? "Loading libraries…"
                : visibilityQ.isError
                  ? "Could not load libraries"
                  : `${visibilityQ.data?.libraries.filter((library) => library.visible).length ?? 0} of ${visibilityQ.data?.libraries.length ?? 0} shown`}
            </span>
          </span>
          <ChevronDown className="size-4 shrink-0 transition-transform group-open:rotate-180" />
        </summary>
        <div className="p-3 pt-1">
          {visibilityQ.isError && (
            <p className="text-xs text-danger">Could not load libraries from this server.</p>
          )}
          {visibilityQ.data?.libraries.length === 0 && (
            <p className="text-xs text-faint">No libraries were found.</p>
          )}
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {visibilityQ.data?.libraries.map((library) => (
              <label key={library.id} className="flex items-center gap-2 text-sm text-muted">
                <input
                  type="checkbox"
                  checked={library.visible}
                  disabled={visibilityMut.isPending}
                  onChange={() => toggleLibrary(library.id)}
                  className="size-4 accent-[var(--color-accent)]"
                />
                <span className="truncate">{library.title}</span>
              </label>
            ))}
          </div>
        </div>
      </details>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Search providers — ThePosterDB login + Fanart.tv/TheTVDB API keys, grouped
// into one card since they're all just "credentials for an artwork source".
// ---------------------------------------------------------------------------

function ArtworkSourcesSection() {
  return (
    <section className="h-full overflow-y-auto rounded-2xl border border-border bg-surface p-4">
      <h2 className="mb-1 flex items-center gap-2 text-lg font-semibold">
        <ImageIcon className="size-5 text-accent" /> Search providers
      </h2>
      <p className="mb-4 text-sm text-faint">
        Accounts and API keys used to search and download posters, backgrounds, banners, and logos.
        {" "}Leave saved key fields blank to keep existing values.
      </p>

      <ArtworkCredentialsFields />
      <div className="mt-3 rounded-xl border border-border bg-surface-2 p-3">
        <h3 className="mb-1 text-sm font-semibold">Provider defaults</h3>
        <p className="mb-3 text-xs text-faint">Choose the source used when opening artwork searches.</p>
        <DefaultArtworkSourceFields />
      </div>

    </section>
  );
}

function DatabaseSection() {
  const serversQ = useQuery({ queryKey: ["servers"], queryFn: api.listServers });
  return (
    <section className="h-full overflow-y-auto rounded-2xl border border-border bg-surface p-4">
      <h2 className="mb-1 flex items-center gap-2 text-lg font-semibold">
        <Database className="size-5 text-accent" /> Cache services
      </h2>
      <p className="mb-3 text-sm text-faint">
        Manage cached artwork and control background preloading.
      </p>
      <div className="space-y-4">
        {serversQ.data?.map((server) => <ArtworkCacheFields key={server.id} server={server} />)}
        {!serversQ.isLoading && serversQ.data?.length === 0 && (
          <p className="rounded-xl border border-border bg-surface-2 p-4 text-sm text-faint">
            Add a media server before configuring cache services.
          </p>
        )}
      </div>
    </section>
  );
}

const ARTWORK_DATABASES = [
  { name: "posterdb", label: "ThePosterDB" },
  { name: "mangadex", label: "MangaDex" },
  { name: "viz", label: "VIZ" },
  { name: "comicvine", label: "ComicVine" },
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
    onMutate: () => reportSettingsSave("saving"),
    onSuccess: (settings) => {
      queryClient.setQueryData(["artwork-settings"], settings);
      toast.push("success", "Default artwork source saved.");
      reportSettingsSave("saved");
    },
    onError: (e: Error) => {
      reportSettingsSave("error");
      queryClient.invalidateQueries({ queryKey: ["artwork-cache"] });
      toast.push("error", e.message);
    },
  });

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div>
        <h3 className="mb-1 text-sm font-semibold">Default database lookup</h3>
        <p className="text-xs text-faint">This source opens first whenever you select a movie, series, or collection.</p>
      </div>
      <select
        className={`${compactInputCls} sm:max-w-sm`}
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
    onMutate: () => reportSettingsSave("saving"),
    onSuccess: (settings) => {
      queryClient.setQueryData(["artwork-settings"], settings);
      queryClient.invalidateQueries({ queryKey: ["artwork-providers"] });
      queryClient.removeQueries({ queryKey: ["artwork"] });
      queryClient.removeQueries({ queryKey: ["artwork-search"] });
      queryClient.removeQueries({ queryKey: ["posterdb-verify"] });
      queryClient.invalidateQueries({ queryKey: ["artwork-cache"] });
      reportSettingsSave("saved");
    },
    onError: (e: Error) => {
      reportSettingsSave("error");
      toast.push("error", e.message);
    },
  });
  const enabled = settingsQ.data?.enabled_providers ?? [];

  return (
    <div>
      <h3 className="mb-1 text-sm font-semibold">Enabled artwork databases</h3>
      <p className="mb-3 text-xs text-faint">Disabled sources are hidden from artwork searches, excluded from Watchdog, and removed from the local cache.</p>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
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
                className="size-4 accent-[var(--color-accent)]"
              />
            </label>
          );
        })}
      </div>
    </div>
  );
}

function ArtworkCacheFields({ server }: { server: Server }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const cacheQ = useQuery({
    queryKey: ["artwork-cache", server.id],
    queryFn: () => api.getArtworkCache(server.id),
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
    mutationFn: (next: Partial<{ max_mb: number; ttl_days: number; watchdog_enabled: boolean; watchdog_interval_hours: number }>) => api.setArtworkCache(server.id, {
      max_mb: next.max_mb ?? maxMb,
      ttl_days: next.ttl_days ?? ttlDays,
      watchdog_enabled: next.watchdog_enabled ?? watchdogEnabled,
      watchdog_interval_hours: next.watchdog_interval_hours ?? watchdogInterval,
    }),
    onMutate: () => reportSettingsSave("saving"),
    onSuccess: (status) => {
      queryClient.setQueryData(["artwork-cache", server.id], status);
      reportSettingsSave("saved");
    },
    onError: (e: Error) => {
      reportSettingsSave("error");
      queryClient.invalidateQueries({ queryKey: ["artwork-cache", server.id] });
      toast.push("error", e.message);
    },
  });

  const clearMut = useMutation({
    mutationFn: () => api.clearArtworkCache(server.id),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["artwork-cache", server.id] });
      queryClient.removeQueries({ queryKey: ["artwork"] });
      queryClient.removeQueries({ queryKey: ["artwork-search"] });
      queryClient.removeQueries({ queryKey: ["posterdb-verify"] });
      toast.push("info", `Cleared ${formatBytes(result.cleared_bytes)} of artwork cache.`);
    },
    onError: (e: Error) => toast.push("error", e.message),
  });

  const watchdogMut = useMutation({
    mutationFn: () => api.runArtworkWatchdog(server.id),
    onSuccess: (result) => {
      queryClient.setQueryData(["artwork-cache", server.id], (current: typeof cacheQ.data) => current ? { ...current, watchdog_running: true } : current);
      toast.push("info", result.message);
    },
    onError: (e: Error) => toast.push("error", e.message),
  });

  const cancelMut = useMutation({
    mutationFn: () => api.cancelArtworkWatchdog(server.id),
    onSuccess: (result) => {
      queryClient.setQueryData(["artwork-cache", server.id], (current: typeof cacheQ.data) => current ? { ...current, watchdog_cancel_requested: true } : current);
      toast.push("info", result.message);
    },
    onError: (e: Error) => toast.push("error", e.message),
  });

  const used = cacheQ.data?.used_bytes ?? 0;
  const limitBytes = Math.max(1, cacheQ.data?.max_mb ?? maxMb) * 1024 * 1024;
  const percent = Math.min(100, (used / limitBytes) * 100);

  return (
    <div className="rounded-xl border border-border bg-surface-2 p-4">
      <h3 className="mb-1 flex items-center gap-2 text-base font-semibold text-white">
        <HardDrive className="size-4 text-accent" /> {cacheQ.data?.server_name ?? server.name} Cache
      </h3>
      <p className="mb-4 text-xs text-faint">
        Keeps recent search results and thumbnails in the persistent Docker data volume so revisits load quickly.
      </p>

      <div className="mb-4 rounded-lg border border-border bg-base/30 p-3">
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

      <div className="mt-5 border-t border-border pt-4">
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
          <div className="flex items-end gap-2">
            <button
              type="button"
              onClick={() => watchdogMut.mutate()}
              disabled={watchdogMut.isPending || cacheQ.data?.watchdog_running}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted hover:text-white disabled:opacity-50"
            >
              {(watchdogMut.isPending || cacheQ.data?.watchdog_running) && <Loader2 className="size-4 animate-spin" />}
              Run Watchdog now
            </button>
            {cacheQ.data?.watchdog_running && (
              <button
                type="button"
                onClick={() => cancelMut.mutate()}
                disabled={cancelMut.isPending || cacheQ.data.watchdog_cancel_requested}
                className="flex shrink-0 items-center justify-center gap-2 rounded-lg border border-danger px-4 py-2 text-sm font-medium text-danger hover:bg-danger/10 disabled:opacity-50"
              >
                {cancelMut.isPending ? <Loader2 className="size-4 animate-spin" /> : <XCircle className="size-4" />}
                {cacheQ.data.watchdog_cancel_requested ? "Stopping…" : "Cancel"}
              </button>
            )}
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
  const [comicvine, setComicvine] = useState("");

  useEffect(() => {
    if (statusQ.data?.email) setEmail(statusQ.data.email);
  }, [statusQ.data?.email]);

  const saveMut = useMutation({
    mutationFn: async (kind: "posterdb" | "fanart" | "tvdb" | "comicvine") => {
      if (kind === "posterdb") return api.setPosterdbCredentials(email.trim(), password);
      if (kind === "fanart") return api.setArtworkSettings({ fanart_api_key: fanart });
      if (kind === "comicvine") return api.setArtworkSettings({ comicvine_api_key: comicvine });
      return api.setArtworkSettings({
        tvdb_api_key: tvdbKey || undefined,
        tvdb_pin: tvdbPin || undefined,
      });
    },
    onSuccess: (_, kind) => {
      queryClient.invalidateQueries({ queryKey: ["posterdb-status"] });
      queryClient.invalidateQueries({ queryKey: ["artwork-settings"] });
      queryClient.invalidateQueries({ queryKey: ["artwork-providers"] });
      if (kind === "posterdb") setPassword("");
      if (kind === "fanart") setFanart("");
      if (kind === "tvdb") { setTvdbKey(""); setTvdbPin(""); }
      if (kind === "comicvine") setComicvine("");
      reportSettingsSave("saved");
    },
    onError: (e: Error) => {
      reportSettingsSave("error");
      toast.push("error", e.message);
    },
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
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      <div className="rounded-xl border border-border bg-surface-2 p-3">
      <ProviderHeading icon={<KeyRound className="size-4 text-accent" />} name="ThePosterDB" connected={statusQ.data?.logged_in === true} />

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
            className={compactInputCls}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
          />
        </Field>
        <Field label="Password">
          <input
            className={compactInputCls}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={configured ? "••••••" : ""}
            onBlur={() => { if (password && email.trim()) saveMut.mutate("posterdb"); }}
          />
        </Field>
      </div>

      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={() => loginMut.mutate()}
          disabled={loginMut.isPending || !configured}
          className="flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-muted transition-colors hover:text-white disabled:opacity-50"
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

      </div>
        <FanartTvdbFields
          fanart={fanart}
          setFanart={setFanart}
          tvdbKey={tvdbKey}
          setTvdbKey={setTvdbKey}
          tvdbPin={tvdbPin}
          setTvdbPin={setTvdbPin}
          comicvine={comicvine}
          setComicvine={setComicvine}
          configured={settingsQ.data}
          onAutoSave={(kind) => saveMut.mutate(kind)}
        />
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
  comicvine,
  setComicvine,
  configured: cfg,
  onAutoSave,
}: {
  fanart: string;
  setFanart: (value: string) => void;
  tvdbKey: string;
  setTvdbKey: (value: string) => void;
  tvdbPin: string;
  setTvdbPin: (value: string) => void;
  comicvine: string;
  setComicvine: (value: string) => void;
  configured?: { fanart_configured: boolean; tvdb_configured: boolean; comicvine_configured: boolean };
  onAutoSave: (kind: "fanart" | "tvdb" | "comicvine") => void;
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
  const comicvineTestMut = useMutation({
    mutationFn: () => api.testArtworkProvider({ provider: "comicvine", comicvine_api_key: comicvine }),
    onSuccess: (result) => toast.push(result.ok ? "success" : "error", result.message),
    onError: (e: Error) => toast.push("error", e.message),
  });

  return (
    <>
      <div className="rounded-xl border border-border bg-surface-2 p-3">
        <ProviderHeading name="Fanart.tv" connected={fanartTestMut.data?.ok === true} />
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
            className={compactInputCls}
            type="password"
            value={fanart}
            onChange={(e) => setFanart(e.target.value)}
            placeholder={cfg?.fanart_configured ? "••••••" : "your Fanart.tv personal API key"}
            onBlur={() => { if (fanart) onAutoSave("fanart"); }}
          />
        </Field>
        <button
          onClick={() => fanartTestMut.mutate()}
          disabled={fanartTestMut.isPending || (!fanart && !cfg?.fanart_configured)}
          className="mt-2 flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-muted transition-colors hover:text-white disabled:opacity-50"
        >
          {fanartTestMut.isPending ? <Loader2 className="size-4 animate-spin" /> : <PlugZap className="size-4" />}
          Test API
        </button>
      </div>

      <div className="rounded-xl border border-border bg-surface-2 p-3">
        <ProviderHeading name="TheTVDB" connected={tvdbTestMut.data?.ok === true} />
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
              className={compactInputCls}
              type="password"
              value={tvdbKey}
              onChange={(e) => setTvdbKey(e.target.value)}
              placeholder={cfg?.tvdb_configured ? "••••••" : "TheTVDB v4 API key"}
              onBlur={() => { if (tvdbKey) onAutoSave("tvdb"); }}
            />
          </Field>
          <Field label="TheTVDB subscriber PIN (optional)">
            <input
              className={compactInputCls}
              value={tvdbPin}
              onChange={(e) => setTvdbPin(e.target.value)}
              placeholder="only for user-supported keys"
              onBlur={() => { if (tvdbPin) onAutoSave("tvdb"); }}
            />
          </Field>
        </div>
        <button
          onClick={() => tvdbTestMut.mutate()}
          disabled={tvdbTestMut.isPending || (!tvdbKey && !cfg?.tvdb_configured)}
          className="mt-2 flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-muted transition-colors hover:text-white disabled:opacity-50"
        >
          {tvdbTestMut.isPending ? <Loader2 className="size-4 animate-spin" /> : <PlugZap className="size-4" />}
          Test API
        </button>
      </div>
      <div className="rounded-xl border border-border bg-surface-2 p-3">
        <ProviderHeading name="ComicVine" connected={comicvineTestMut.data?.ok === true} />
        <Field label={<><span>ComicVine API key</span>{cfg?.comicvine_configured && <ConfiguredTag />} <a href="https://comicvine.gamespot.com/api/" target="_blank" rel="noreferrer" className="text-xs text-muted hover:text-white">(request a free key ↗)</a></>}>
          <input className={compactInputCls} type="password" value={comicvine} onChange={(e) => setComicvine(e.target.value)} placeholder={cfg?.comicvine_configured ? "••••••" : "your ComicVine API key"} onBlur={() => { if (comicvine) onAutoSave("comicvine"); }} />
        </Field>
        <button onClick={() => comicvineTestMut.mutate()} disabled={comicvineTestMut.isPending || (!comicvine && !cfg?.comicvine_configured)} className="mt-2 flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-muted transition-colors hover:text-white disabled:opacity-50">
          {comicvineTestMut.isPending ? <Loader2 className="size-4 animate-spin" /> : <PlugZap className="size-4" />} Test API
        </button>
      </div>
    </>
  );
}

function ProviderHeading({ name, connected, icon }: { name: string; connected: boolean; icon?: ReactNode }) {
  return (
    <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
      {icon ?? <ImageIcon className="size-4 text-accent" />}
      <span>{name}</span>
      {connected && <CheckCircle2 className="size-4 text-green-500" aria-label="Connection successful" />}
    </h3>
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

const compactInputCls =
  "w-full rounded-lg border border-border bg-input px-3 py-1.5 text-sm outline-none transition-colors hover:bg-input-hover focus:border-accent";

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
