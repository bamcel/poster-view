import ScheduledTasks from "../components/ScheduledTasks";
import HexColorPicker from "../components/HexColorPicker";
import {useNavigate as useLibraryNavigate} from "../lib/libraryNavigation";
import PluginsPage from "../components/PluginsPage";
import ServerSettingsDashboard from "../components/ServerSettingsDashboard";
// Settings: manage media servers (add/edit/test/delete) and ThePosterDB login.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Navigate, useLocation, useSearchParams } from "react-router-dom";
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
  LayoutDashboard,
  Columns2,
} from "lucide-react";
import NativeProviderCredentials from "../components/NativeProviderCredentials";
import { api, type ServerInput } from "../api/client";
import { useToast } from "../lib/toast";
import { ServerTypeBadge, Switch } from "../components/ui";
import type { AppearanceSettings, ConnectionTest, Server, ServerType } from "../types";
import {
  applyTheme,
  applyThemePreferences,
  exportThemePreferences,
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
import ProviderConnection, { providerStatus } from "../components/ProviderConnection";
import SecuritySection from "../components/SecuritySection";
import NativeLibrariesSection, {NativeLibraryCount} from "../components/NativeLibrariesSection";
import AppearancePreview from "../components/AppearancePreview";
import { reportSettingsSave, type SettingsSaveStatus } from "../lib/settingsSaveStatus";
import { DEFAULT_BACKDROP_BLUR, DEFAULT_BACKDROP_OVERLAY, DEFAULT_BACKDROPS_ENABLED, DEFAULT_PANEL_OVERLAY, DEFAULT_PANEL_SOLIDITY, DEFAULT_PILL_BACKGROUND_OPACITY, pillBackgroundOpacity, setPillBackgroundOpacity, backdropBlur, backdropOverlay, dashboardAppearance, dashboardBackdropEnabled, panelOverlay, panelSolidity, setBackdropBlur, setBackdropOverlay, setDashboardBackdropEnabled, setPanelOverlay, setPanelSolidity } from "../lib/dashboardSettings";

const BLANK: ServerInput = {
  name: "",
  type: "emby",
  base_url: "",
  token: "",
  is_default: false,
  nfo_metadata_enabled: false,
};

const URL_PLACEHOLDER: Record<ServerType, string> = {
  plex: "http://localhost:32400",
  jellyfin: "http://localhost:8096",
  emby: "http://localhost:8096",
};

const TOKEN_LABEL: Record<ServerType, string> = {
  plex: "Plex Token (X-Plex-Token)",
  jellyfin: "API Key",
  emby: "API Key",
};

type SettingsTab = "servers" | "plugins" | "artwork" | "libraries" | "sources" | "tasks" | "appearance" | "security";

const LIVE_PREVIEW_KEY = "posterview.appearanceLivePreview";

const TABS: { id: SettingsTab; label: string; icon: ReactNode }[] = [
  { id: "artwork", label: "Artwork", icon: <ImageIcon className="size-4" /> },
  { id: "plugins", label: "Plugins", icon: <ServerIcon className="size-4" /> },
  { id: "servers", label: "Server Connect", icon: <ServerIcon className="size-4" /> },
  { id: "libraries", label: "Libraries", icon: <HardDrive className="size-4" /> },
  { id: "sources", label: "Search Providers", icon: <ImageIcon className="size-4" /> },
  { id: "tasks", label: "Scheduled Tasks", icon: <Database className="size-4" /> },
  { id: "appearance", label: "Appearance", icon: <Palette className="size-4" /> },
  { id: "security", label: "Privacy / Security", icon: <KeyRound className="size-4" /> },
];

export default function SettingsPage({previewSection}: {previewSection?: string} = {}) {
  const navigate=useLibraryNavigate();
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const requestedTab = searchParams.get("tab") === "database" ? "tasks" : searchParams.get("tab");
  const section = previewSection ?? location.pathname.split("/")[2];
  const candidate = section === "database" ? "tasks" : section;
  const tab = TABS.find(section => section.id === candidate)?.id;
  const [pluginOpen,setPluginOpen]=useState(false);
  const [artworkOpen,setArtworkOpen]=useState(false);
  const [saveStatus, setSaveStatus] = useState<SettingsSaveStatus>("saved");

  useEffect(() => {
    const update = (event: Event) => setSaveStatus((event as CustomEvent<SettingsSaveStatus>).detail);
    window.addEventListener("posterview:settings-save", update);
    return () => window.removeEventListener("posterview:settings-save", update);
  }, []);

  if (!previewSection && requestedTab && TABS.some(section => section.id === requestedTab)) return <Navigate replace to={`/settings/${requestedTab}`} />;
  if (!tab) return <ServerSettingsDashboard />;
  return (
    <div className="h-full overflow-y-auto px-4 py-4 sm:px-6 lg:px-8 xl:overflow-hidden">
      <div className="flex min-h-full w-full flex-col gap-4 xl:h-full xl:min-h-0">
        <h1 className="text-2xl font-semibold">{TABS.find(section => section.id === tab)?.label}</h1>

        <div className={tab === "libraries" ? "flex items-end justify-between gap-4 border-b border-border pb-1" : "flex flex-col gap-2 border-b border-border pb-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4"}>
          <span role="status" className={`shrink-0 self-end text-xs sm:self-auto ${saveStatus === "error" ? "text-danger" : "text-accent"}`}>
            {tab === "libraries" ? "Save changes in the library dialog." : tab === "tasks" ? "Save task schedules individually." : saveStatus === "saving" ? "Saving settings…" : saveStatus === "error" ? "Settings could not be saved." : "Settings saved automatically."}
          </span>
          {tab === "libraries" && <NativeLibraryCount/>}
        </div>

        <div className="min-h-0 flex-1">
          {(tab === "plugins" || tab === "servers" || tab === "artwork") && <PluginsPage artworkOpen={tab === "artwork" || artworkOpen} onArtworkOpen={()=>setArtworkOpen(true)} open={tab === "servers" || pluginOpen} onOpen={()=>setPluginOpen(true)} onClose={()=>{setPluginOpen(false);setArtworkOpen(false);if(tab === "servers" || tab === "artwork") navigate("/settings/plugins");}}/>}
          {tab === "libraries" && <NativeLibrariesSection />}
          {tab === "sources" && <ArtworkSourcesSection />}
          {tab === "tasks" && <div className="h-full overflow-y-auto"><div><ScheduledTasks/></div></div>}
          {tab === "appearance" && <AppearanceSection preview={!!previewSection} />}
          {tab === "security" && <SecuritySection />}
        </div>
      </div>
    </div>
  );
}

function AppearanceSection({preview=false}: {preview?:boolean}) {
  const queryClient = useQueryClient();
  const [splitView, setSplitView] = useState(() => localStorage.getItem(LIVE_PREVIEW_KEY) === "true");
  useEffect(() => {
    localStorage.setItem(LIVE_PREVIEW_KEY, String(splitView));
  }, [splitView]);
  const [desktop, setDesktop] = useState(() => window.innerWidth >= 1280);
  const [settingsWidth, setSettingsWidth] = useState(40);
  const splitRef = useRef<HTMLDivElement>(null);
  const split = splitView && desktop && !preview;
  useEffect(() => {
    const resize = () => setDesktop(window.innerWidth >= 1280);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const [themes, setThemes] = useState(getAllThemes);
  const [selected, setSelected] = useState(getStoredThemeName);
  const [themeJson, setThemeJson] = useState(() => serializeTheme(getTheme(getStoredThemeName())));
  const [selectedColor, setSelectedColor] = useState<ThemeColorKey>("accent");
  const [customName, setCustomName] = useState("");
  const [message, setMessage] = useState("");
  const [showBackdrops, setShowBackdrops] = useState(dashboardBackdropEnabled);
  const [panelSolid, setPanelSolid] = useState(panelSolidity);
  const [blur, setBlur] = useState(backdropBlur);
  const [panelOverlayStrength, setPanelOverlayStrength] = useState(panelOverlay);
  const [backdropOverlayStrength, setBackdropOverlayStrength] = useState(backdropOverlay);
  const [pillOpacity, setPillOpacity] = useState(pillBackgroundOpacity);
  const settingsQ = useQuery({ queryKey: ["appearance-settings"], queryFn: api.appearanceSettings });
  const pendingSave = useRef<AppearanceSettings | null>(null);
  const appearanceDraft = useRef<AppearanceSettings | null>(null);
  const saveRunning = useRef(false);

  useEffect(() => {
    const settings = settingsQ.data;
    if (!settings?.configured || saveRunning.current) return;
    appearanceDraft.current = settings;
    setShowBackdrops(settings.backdrops_enabled);
    setPanelSolid(settings.panel_solidity);
    setBlur(settings.panel_blur);
    setPanelOverlayStrength(settings.panel_overlay);
    setBackdropOverlayStrength(settings.backdrop_overlay);
    setPillOpacity(settings.pill_background_opacity ?? DEFAULT_PILL_BACKGROUND_OPACITY);
    applyThemePreferences(settings.theme_name, settings.custom_themes_json);
    setThemes(getAllThemes());
    setSelected(getStoredThemeName());
    setThemeJson(serializeTheme(getTheme(getStoredThemeName())));
  }, [settingsQ.data]);

  const persist = (overrides: Partial<AppearanceSettings> = {}) => {
    const next: AppearanceSettings = {
      configured: true,
      ...dashboardAppearance(),
      ...appearanceDraft.current,
      ...exportThemePreferences(),
      ...overrides,
    };
    reportSettingsSave("saving");
    appearanceDraft.current = next;
    pendingSave.current = next;
    if (saveRunning.current) return;
    saveRunning.current = true;
    // Serialize writes and coalesce slider movements while a request is in flight.
    // Only the final response may update the shared cache and reapply appearance.
    void (async () => {
      while (pendingSave.current) {
        const settings = pendingSave.current;
        pendingSave.current = null;
        try {
          const saved = await api.saveAppearanceSettings(settings);
          if (!pendingSave.current) {
            queryClient.setQueryData(["appearance-settings"], saved);
            reportSettingsSave("saved");
          }
        } catch {
          if (!pendingSave.current) reportSettingsSave("error");
        }
      }
      saveRunning.current = false;
    })();
  };

  const changeBackdrops = (enabled: boolean) => {
    setShowBackdrops(enabled);
    setDashboardBackdropEnabled(enabled);
    persist({ backdrops_enabled: enabled });
  };
  const changePanelSolid = (value: number) => { setPanelSolid(value); setPanelSolidity(value); persist({ panel_solidity: value }); };
  const changeBlur = (value: number) => { setBlur(value); setBackdropBlur(value); persist({ panel_blur: value }); };
  const changePanelOverlay = (value: number) => { setPanelOverlayStrength(value); setPanelOverlay(value); persist({ panel_overlay: value }); };
  const changeBackdropOverlay = (value: number) => { setBackdropOverlayStrength(value); setBackdropOverlay(value); persist({ backdrop_overlay: value }); };
  const changePillOpacity = (value: number) => { setPillOpacity(value); setPillBackgroundOpacity(value); persist({ pill_background_opacity: value }); };
  const resetDashboard = () => {
    setShowBackdrops(DEFAULT_BACKDROPS_ENABLED);
    setPanelSolid(DEFAULT_PANEL_SOLIDITY);
    setBlur(DEFAULT_BACKDROP_BLUR);
    setPanelOverlayStrength(DEFAULT_PANEL_OVERLAY);
    setBackdropOverlayStrength(DEFAULT_BACKDROP_OVERLAY);
    setPillOpacity(DEFAULT_PILL_BACKGROUND_OPACITY);
    setPillBackgroundOpacity(DEFAULT_PILL_BACKGROUND_OPACITY);
    setDashboardBackdropEnabled(DEFAULT_BACKDROPS_ENABLED);
    setPanelSolidity(DEFAULT_PANEL_SOLIDITY);
    setBackdropBlur(DEFAULT_BACKDROP_BLUR);
    setPanelOverlay(DEFAULT_PANEL_OVERLAY);
    setBackdropOverlay(DEFAULT_BACKDROP_OVERLAY);
    persist({ backdrops_enabled: DEFAULT_BACKDROPS_ENABLED, panel_solidity: DEFAULT_PANEL_SOLIDITY, panel_blur: DEFAULT_BACKDROP_BLUR, panel_overlay: DEFAULT_PANEL_OVERLAY, backdrop_overlay: DEFAULT_BACKDROP_OVERLAY, pill_background_opacity: DEFAULT_PILL_BACKGROUND_OPACITY });
  };

  const choose = (name: string) => {
    const theme = getTheme(name);
    setSelected(applyTheme(theme));
    setThemeJson(serializeTheme(theme));
    setCustomName(loadCustomThemes().some((candidate) => candidate.name === name) ? name : "");
    setMessage(`Theme applied: ${name}`);
    persist({ theme_name: name });
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
      persist({ ...exportThemePreferences(), theme_name: theme.name });
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
    persist(exportThemePreferences());
  };

  let previewColors = getTheme(selected);
  try {
    previewColors = parseThemeJson(themeJson);
  } catch { /* Keep the selected theme while JSON is incomplete. */ }
  const selectedColorValue = previewColors[selectedColor];

  return (
    <div ref={splitRef} className="h-full min-h-0 min-w-0" style={split ? { display: "grid", gridTemplateColumns: `minmax(0, ${settingsWidth}fr) 12px minmax(0, ${100 - settingsWidth}fr)` } : undefined}>
    <section className="h-full min-h-0 min-w-0 overflow-y-auto rounded-2xl border border-border bg-surface p-4">
      <div className="min-h-full w-full">
        <div className="mb-1 flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <LayoutDashboard className="size-5 text-accent" /> Dashboard
        </h2>
        <button type="button" aria-pressed={split} onClick={() => setSplitView(value => !value)} className="hidden shrink-0 items-center gap-2 rounded-lg border border-border bg-button px-3 py-2 text-sm font-medium hover:bg-button-hover xl:flex"><Columns2 className="size-4" />Split View</button>
        </div>
        <p className="mb-3 text-sm text-faint">Customize dashboard artwork and panel visibility.</p>
        <div className="rounded-xl border border-border bg-surface-2 p-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-white">Show Backdrops</p>
              <p className="mt-1 text-xs text-faint">Show rotating Dashboard artwork and selected-series backgrounds.</p>
            </div>
            <Switch label="Show Backdrops" checked={showBackdrops} onChange={() => changeBackdrops(!showBackdrops)} />
          </div>
          <DashboardSlider label="Panel Color" value={panelSolid} suffix="%" min={0} max={100} onChange={changePanelSolid} start="Transparent" end="Solid" />
          <DashboardSlider label="Panel Blur" value={blur} suffix="px" min={0} max={30} step={2} onChange={changeBlur} start="No blur" end="Blurred" />
          <DashboardSlider label="Panel Overlay" value={panelOverlayStrength} suffix="%" min={0} max={95} onChange={changePanelOverlay} start="Light" end="Dark" />
          <DashboardSlider label="Backdrop Overlay" value={backdropOverlayStrength} suffix="%" min={0} max={95} onChange={changeBackdropOverlay} start="Light" end="Dark" />
          <DashboardSlider label="Pill Background" value={pillOpacity} suffix="%" min={0} max={100} onChange={changePillOpacity} start="Transparent" end="Solid" />
          <p className="mt-1 text-xs text-faint">Background opacity for series metadata pills and season episode-count pills. Text and borders stay visible.</p>
          <button type="button" onClick={resetDashboard} className="mt-4 h-10 rounded-lg border border-border bg-button px-4 text-sm font-medium text-muted transition-colors hover:bg-button-hover hover:text-white">Reset to default</button>
        </div>

        <div className="mt-6">
          <h2 className="mb-1 flex items-center gap-2 text-lg font-semibold">
            <Palette className="size-5 text-accent" /> Theme
          </h2>
          <p className="mb-3 text-sm text-faint">Select a palette or preview an individual color.</p>
          <div className="rounded-xl border border-border bg-surface-2 p-4">
          <div className="flex items-end gap-2">
            <ThemePicker themes={themes} selected={selected} onSelect={choose} />
            <button type="button" onClick={reload} className="h-10 shrink-0 rounded-lg border border-border bg-button px-4 text-sm font-medium text-muted hover:bg-button-hover hover:text-white">
              Reload theme
            </button>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <ColorLabelPicker theme={previewColors} selected={selectedColor} onSelect={setSelectedColor} />
            <div className="text-xs font-semibold text-muted">
              {THEME_COLOR_OPTIONS.find((option) => option.key === selectedColor)?.label}
              <HexColorPicker label={THEME_COLOR_OPTIONS.find((option) => option.key === selectedColor)!.label} value={selectedColorValue} onChange={updateColor}/>
            </div>
          </div>
          <p className="mt-2 text-xs text-faint">Color changes preview immediately. Save them as a custom theme to keep them.</p>

        <div className="mt-4 border-t border-border pt-4">
          <h2 className="text-lg font-semibold">Custom Theme</h2>
          <p className="mt-1 text-sm text-faint">Save the edited JSON under a unique name or remove a selected custom theme.</p>
          <details className="group mt-4 rounded-xl border border-border bg-panel">
            <summary aria-label="Toggle JSON Editor" className="flex h-10 cursor-pointer list-none items-center justify-between gap-3 px-4 text-sm font-semibold text-muted outline-none marker:hidden hover:text-white focus-visible:text-white">
              <span>JSON Editor</span>
              <span className="text-faint transition-transform group-open:rotate-180">⌄</span>
            </summary>
            <div className="border-t border-border p-4">
              <p className="text-sm text-faint">Edit or paste a complete PosterView theme definition.</p>
              <label className="mt-4 block text-xs font-semibold text-muted">
                JSON Editor
                <textarea
                  value={themeJson}
                  onChange={(event) => setThemeJson(event.target.value)}
                  spellCheck={false}
                  style={{ fontSize: "0.5625rem", lineHeight: "0.75rem" }}
                  className="mt-2 min-h-80 w-full resize-y rounded-lg border border-border bg-input p-4 font-mono font-normal text-white outline-none focus:border-accent"
                />
              </label>
            </div>
          </details>
          <label className="mt-4 block text-xs font-semibold text-muted">
            Custom Theme Name
            <input value={customName} onChange={(event) => setCustomName(event.target.value)} placeholder="My theme" className={`${compactInputCls} mt-2 h-10`} />
          </label>
          <button type="button" onClick={save} className="mt-4 h-10 w-full rounded-lg bg-accent px-4 text-sm font-semibold text-white hover:bg-accent-hover">Save custom theme</button>
          <button type="button" onClick={remove} disabled={!selectedIsCustom} className="mt-2 h-10 w-full rounded-lg border border-border bg-button px-4 text-sm font-medium text-muted hover:bg-button-hover hover:text-white disabled:cursor-not-allowed disabled:text-disabled">Remove custom theme</button>
          {message && <p role="status" className="mt-3 text-xs text-faint">{message}</p>}
        </div>
          </div>
        </div>
      </div>
    </section>
    {split && <>
      <div role="separator" aria-label="Resize settings and preview" aria-orientation="vertical" aria-valuemin={30} aria-valuemax={60} aria-valuenow={Math.round(settingsWidth)} tabIndex={0}
        className="group flex touch-none cursor-col-resize items-center justify-center outline-none"
        onPointerDown={event => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={event => { if (!event.currentTarget.hasPointerCapture(event.pointerId)) return; const bounds = splitRef.current!.getBoundingClientRect(); setSettingsWidth(Math.max(30, Math.min(60, (event.clientX - bounds.left) / bounds.width * 100))); }}
        onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
        onKeyDown={event => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); setSettingsWidth(value => Math.max(30, Math.min(60, value + (event.key === "ArrowLeft" ? -2 : 2)))); } }}>
        <span className="h-12 w-1 rounded-full bg-border group-hover:bg-accent group-focus-visible:bg-accent" />
      </div>
      <AppearancePreview onClose={() => setSplitView(false)} />
    </>}
    </div>
  );
}

function DashboardSlider({ label, value, suffix, min, max, step = 1, onChange, start, end }: { label: string; value: number; suffix: string; min: number; max: number; step?: number; onChange: (value: number) => void; start: string; end: string }) {
  return (
    <label className="mt-4 block text-sm font-medium text-white">
      <span className="flex items-center justify-between gap-3">
        <span>{label}</span>
        <span className="text-xs font-semibold text-accent">{value}{suffix}</span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} aria-label={label} className="mt-3 w-full accent-[var(--color-accent)]" />
      <span className="mt-1 flex justify-between text-xs font-normal text-faint"><span>{start}</span><span>{end}</span></span>
    </label>
  );
}

function ThemePicker({ themes, selected, onSelect }: { themes: AppTheme[]; selected: string; onSelect: (name: string) => void }) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const selectedTheme = themes.find((theme) => theme.name === selected) ?? themes[0];
  return (
    <div className="min-w-0 flex-1 text-xs font-semibold text-muted">
      <span>Theme</span>
      <details ref={detailsRef} className="group relative mt-2" onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); detailsRef.current?.removeAttribute("open"); detailsRef.current?.querySelector("summary")?.focus(); }
      }}>
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

function ColorLabelPicker({ theme, selected, onSelect }: { theme: AppTheme; selected: ThemeColorKey; onSelect: (key: ThemeColorKey) => void }) {
  const details = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!details.current?.contains(event.target as Node)) details.current?.removeAttribute("open");
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);
  const swatch = (key: ThemeColorKey) => <span aria-hidden="true" className="size-4 shrink-0 rounded-sm border border-border" style={{ backgroundColor: theme[key] }} />;
  return <div className="min-w-0 text-xs font-semibold text-muted">
    <span>Color Label</span>
    <details ref={details} className="relative mt-2" onKeyDown={(event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        details.current?.removeAttribute("open");
        details.current?.querySelector("summary")?.focus();
      }
    }}>
      <summary aria-label="Select Color Label" className="flex h-10 cursor-pointer list-none items-center gap-2 rounded-lg border border-border bg-input px-3 marker:hidden focus-visible:outline-accent">
        {swatch(selected)}
        <span className="flex-1">{THEME_COLOR_OPTIONS.find((option) => option.key === selected)?.label}</span>
        <ChevronDown className="size-4" />
      </summary>
      <div className="absolute z-30 mt-1 max-h-72 w-full overflow-y-auto rounded-lg border border-border bg-sidebar p-1 shadow-2xl">
        {THEME_COLOR_OPTIONS.map((option) => <button key={option.key} type="button" aria-pressed={selected === option.key}
          className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs text-white hover:bg-surface-2 focus-visible:outline-accent"
          onClick={() => {
            onSelect(option.key);
            details.current?.removeAttribute("open");
            details.current?.querySelector("summary")?.focus();
          }}>
          {swatch(option.key)}<span>{option.label}</span>
        </button>)}
      </div>
    </details>
  </div>;
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

export function ServersSection() {
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
    setForm({ name: s.name, type: s.type, base_url: s.base_url, token: "", is_default: s.is_default, nfo_metadata_enabled: s.nfo_metadata_enabled });
    setTestResult(null);
    setFormOpen(true);
  };

  const saveMut = useMutation({
    mutationFn: async () => {
      const input = { ...form, base_url: form.base_url.trim(), token: form.token.trim() };
      if (editingId == null) return api.createServer(input);
      return api.updateServer(editingId, input);
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
      const input = { ...form, base_url: form.base_url.trim(), token: form.token.trim() };
      const r =
        editingId != null
          ? await api.testServerSaved(editingId, input)
          : await api.testServerAdhoc(input);
      setTestResult(r);
      toast.push(r.ok ? "success" : "error", r.message);
    } catch (e) {
      setTestResult({ ok: false, message: (e as Error).message, server_name: null, version: null });
      toast.push("error", (e as Error).message);
    } finally {
      setTesting(false);
    }
  };

  const canSubmit = form.name.trim() && form.base_url.trim() && (editingId != null || form.token);

  return (
    <section className="space-y-5">

      <div>
        <div className="space-y-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h3 className="mb-1 text-sm font-semibold">Connected servers</h3>
              <p className="text-xs text-faint">
                Connect Plex, Jellyfin, or Emby. Tokens are encrypted before they're stored.
              </p>
            </div>
            {!formOpen ? (
              <button
                type="button"
                onClick={startAdd}
                className="flex shrink-0 items-center gap-2 rounded-lg border border-border bg-button px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-button-hover"
              >
                <Plus className="size-4 text-accent" /> Add server
              </button>
            ) : (
              <button
                type="button"
                onClick={reset}
                className="flex shrink-0 items-center gap-2 rounded-lg border border-border bg-button px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-button-hover"
              >
                <XCircle className="size-4" /> Cancel
              </button>
            )}
          </div>

          {/* Existing servers */}
          <div className="mb-3 divide-y divide-border">
            {serversQ.data?.length === 0 && (
              <p className="py-4 text-sm text-faint">
                No servers yet — use Add server to connect one.
              </p>
            )}
            {serversQ.data?.map((s) => (
              <ServerCard
                key={s.id}
                server={s}
                onEdit={() => startEdit(s)}
                onDelete={() => {
                  if (confirm(`Delete server "${s.name}" (${s.base_url}, ID ${s.id}) from PosterView?\n\nThis removes its saved connection, artwork cache, and cached media-server images. Your media files and artwork on the server remain unchanged. Other servers’ caches are kept.`)) deleteMut.mutate(s.id);
                }}
              />
            ))}
          </div>

          {/* Add / edit form */}
          <div className="px-1 pt-1">
            {formOpen && (
              <>
            <h3 className="mb-3 text-sm font-semibold">
              {editingId == null ? "Add A Server" : "Edit Server"}
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
          Use As Default Integration
            </label>

            <label className="mt-3 flex items-start gap-2 text-sm text-muted">
          <input
            type="checkbox"
            checked={form.nfo_metadata_enabled}
            onChange={(e) => setForm({ ...form, nfo_metadata_enabled: e.target.checked })}
            className="mt-0.5 size-4 accent-[var(--color-accent)]"
          />
          <span>
            <span className="block text-white">Enable NFO Metadata</span>
            <span className="block text-xs text-faint">
              Allow PosterView to create and maintain NFO files for this server. The configured media path must be writable.
            </span>
          </span>
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
            </div>
              </>
            )}
          </div>
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
  return (
    <div className="py-4">
      <div className="flex items-start gap-2 sm:gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="min-w-0 break-words font-medium">{server.name}</span>
            <ServerTypeBadge type={server.type} />
            {server.is_default && (
              <span className="flex items-center gap-1 text-xs text-accent">
                <Star className="size-3 fill-accent" /> default
              </span>
            )}
          </div>
          <p className="truncate text-xs text-faint">{server.base_url}</p>
        </div>
        <IconBtn title={`Edit ${server.name}`} onClick={onEdit}>
          <Pencil className="size-4" />
        </IconBtn>
        <IconBtn title={`Delete ${server.name}`} danger onClick={onDelete}>
          <Trash2 className="size-4" />
        </IconBtn>
      </div>

      <p className="mt-3 text-xs text-muted">Integration connection for importing metadata and pushing supported updates. Manage library connections below in Server Connect.</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Search providers — ThePosterDB login + Fanart.tv/TheTVDB API Keys, grouped
// into one card since they're all just "credentials for an artwork source".
// ---------------------------------------------------------------------------

function ArtworkSourcesSection() {
  return (
    <section className="h-full overflow-y-auto rounded-2xl border border-border bg-surface p-4">
      <h2 className="mb-1 flex items-center gap-2 text-lg font-semibold">
        <ImageIcon className="size-5 text-accent" /> Search Providers
      </h2>
      <p className="mb-4 text-sm text-faint">
        Accounts and API keys used to search and download artwork and supported book metadata.
        {" "}Leave saved key fields blank to keep existing values.
      </p>

      <DefaultArtworkSourcesFields />
      <h3 className="mb-2 mt-6 text-sm font-semibold">Accounts &amp; connections</h3>
      <p className="mb-3 text-xs text-faint">Expand a provider to configure credentials or test its connection.</p>
      <div className="overflow-hidden rounded-xl border border-border">
        <TmdbCredentialsFields />
        <ArtworkCredentialsFields />
        {[
          { id: "anilist", name: "AniList", description: "Anime artwork", url: "https://anilist.co" },
          { id: "anilist-manga", name: "AniList Manga", description: "Manga artwork and metadata", url: "https://anilist.co" },
          { id: "mediux", name: "MediUX", description: "Movie and TV artwork", url: "https://mediux.pro" },
          { id: "mangadex", name: "MangaDex", description: "Manga covers", url: "https://mangadex.org" },
          { id: "viz", name: "VIZ", description: "Manga covers", url: "https://www.viz.com" },
        ].map(provider => <ProviderConnection key={provider.id} id={provider.id} name={provider.name} description={provider.description} status="No credentials required" setupUrl={provider.url} setupLabel="Visit provider">
          <p className="text-sm text-muted">{provider.name} is available automatically. No account or API key is needed for searches.</p>
        </ProviderConnection>)}
      </div>

    </section>
  );
}

function TmdbCredentialsFields() {
  const [token, setToken] = useState("");
  const client = useQueryClient();
  const toast = useToast();
  const settings = useQuery({ queryKey: ["artwork-settings"], queryFn: api.getArtworkSettings });
  const test = useMutation({ mutationFn: () => api.testArtworkProvider({ provider: "tmdb" }) });
  const save = useMutation({
    mutationFn: (value: string) => api.setArtworkSettings({ tmdb_access_token: value }),
    onMutate: () => reportSettingsSave("saving"),
    onSuccess: (value, savedToken) => {
      client.setQueryData(["artwork-settings"], value);
      setToken(current => current.trim() === savedToken ? "" : current);
      test.reset();
      reportSettingsSave("saved");
      toast.push("success", "TMDB credentials saved.");
    },
    onError: (error: Error) => {
      reportSettingsSave("error");
      toast.push("error", error.message);
    },
  });
  return <ProviderConnection id="tmdb" name="TMDB" description="Movie and TV metadata" status={settings.isError ? "Configuration unavailable" : save.isPending ? "Saving…" : providerStatus(settings.data?.tmdb_configured, test.isPending, test.data, test.error)} setupUrl="https://www.themoviedb.org/settings/api">
    <form onSubmit={event => { event.preventDefault(); if (token.trim() && !save.isPending) save.mutate(token.trim()); }}>
    <p className="mt-1 text-xs text-faint">Save and test your TMDB credentials. Automatic TMDB metadata fetching is not included in this development build.</p>
    <p className="mt-2 text-xs text-muted" role="status">{save.isPending ? "Saving…" : settings.isLoading ? "Checking configuration…" : settings.isError ? "Unable to load configuration." : settings.data?.tmdb_configured ? "Token saved" : "Not configured"}</p>
    <div className="mt-3 flex flex-wrap items-end gap-3">
      <label className="min-w-0 flex-1 text-xs font-medium text-muted">TMDB API Read Access Token or API key
        <input type="password" autoComplete="off" className={`${compactInputCls} mt-1 w-full`} value={token} disabled={save.isPending} onBlur={() => { if (token.trim() && !save.isPending) save.mutate(token.trim()); }} onChange={event => { setToken(event.target.value); save.reset(); test.reset(); }} placeholder={settings.data?.tmdb_configured ? "Leave blank to keep saved token" : "Paste API Read Access Token"} />
      </label>
      <button type="button" className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-surface disabled:opacity-50" disabled={!settings.data?.tmdb_configured || test.isPending || save.isPending || !!token.trim()} onClick={() => test.mutate()}>{test.isPending ? "Testing…" : "Test Connection"}</button>
    </div>
    <p className="mt-2 text-xs text-faint">Accepts a TMDB API Read Access Token or a v3 API key. Changes save automatically when you leave the field.</p>
    {test.data && <p role="status" className={`mt-2 text-sm ${test.data.ok ? "text-green-400" : "text-red-400"}`}>{test.data.message}</p>}
    {test.isError && <p role="alert" className="mt-2 text-sm text-red-400">{test.error.message}</p>}
    {save.isError && <p role="alert" className="mt-2 text-sm text-red-400">{save.error.message}</p>}
  </form></ProviderConnection>;
}

const ARTWORK_DATABASES = [
  { name: "deviantart", label: "DeviantArt" },
  { name: "posterdb", label: "ThePosterDB" },
  { name: "mangadex", label: "MangaDex" },
  { name: "viz", label: "VIZ" },
  { name: "comicvine", label: "ComicVine" },
  { name: "fanart", label: "Fanart.tv" },
  { name: "tvdb", label: "TheTVDB" },
  { name: "anilist", label: "AniList" },
  { name: "anilist-manga", label: "AniList Manga" },
  { name: "mediux", label: "MediUX" },
];

function DefaultArtworkSourceFields({ kind, names }: { kind: "poster" | "ereader"; names: string[] }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const settingsQ = useQuery({ queryKey: ["artwork-settings"], queryFn: api.getArtworkSettings });
  const saveMut = useMutation({
    mutationFn: (provider: string) => api.setArtworkSettings(
      kind === "poster" ? { default_provider: provider } : { ereader_default_provider: provider },
    ),
    onMutate: () => reportSettingsSave("saving"),
    onSuccess: (settings) => {
      queryClient.setQueryData(["artwork-settings"], settings);
      toast.push("success", `Default ${kind === "poster" ? "poster" : "eReader"} source saved.`);
      reportSettingsSave("saved");
    },
    onError: (e: Error) => {
      reportSettingsSave("error");
      queryClient.invalidateQueries({ queryKey: ["artwork-cache"] });
      toast.push("error", e.message);
    },
  });

  return (
    <label className="flex w-full flex-col gap-1 text-xs font-medium text-muted">
      Default provider
      <select
        title={kind === "poster"
          ? "Opens first whenever you select a movie, series, or collection."
          : "Opens first whenever you select book-related media."}
        className={compactInputCls}
        value={(kind === "poster" ? settingsQ.data?.default_provider : settingsQ.data?.ereader_default_provider) ?? ""}
        onChange={(event) => saveMut.mutate(event.target.value)}
        disabled={settingsQ.isLoading || saveMut.isPending}
      >
        {ARTWORK_DATABASES.filter((source) => names.includes(source.name)).map((source) => (
          <option key={source.name} value={source.name}>{source.label}</option>
        ))}
      </select>
    </label>
  );
}

export function DefaultArtworkSourcesFields({flat=false}:{flat?:boolean}={}) {
  return <div className="grid gap-4 lg:grid-cols-2">
    {[
      { label: "Poster", kind: "poster" as const, names: ["anilist", "fanart", "mediux", "posterdb", "tvdb", "deviantart"] },
      { label: "eReader", kind: "ereader" as const, names: ["anilist-manga", "comicvine", "mangadex", "viz", "deviantart"] },
    ].map(group => <div key={group.kind} role="group" aria-labelledby={`provider-group-${group.kind}`} className={flat ? "min-w-0 border-b border-border pb-5" : "min-w-0 rounded-xl border border-border bg-surface-2 p-4"}>
      <h3 id={`provider-group-${group.kind}`} className="mb-3 text-sm font-semibold">{group.label} providers</h3>
      <DefaultArtworkSourceFields kind={group.kind} names={group.names} />
    </div>)}
  </div>;
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
    <>
      <ProviderConnection id="posterdb" name="ThePosterDB" description="Posters" status={statusQ.isError ? "Configuration unavailable" : providerStatus(configured, loginMut.isPending, loginMut.data ? { ok: loginMut.data.logged_in } : statusQ.data?.logged_in ? { ok: true } : undefined, loginMut.error)} setupUrl="https://theposterdb.com/register">

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Email / username">
          <input
            className={compactInputCls}
            value={email}
            onChange={(e) => { setEmail(e.target.value); loginMut.reset(); }}
            placeholder="you@example.com"
          />
        </Field>
        <Field label="Password">
          <input
            className={compactInputCls}
            type="password"
            value={password}
            onChange={(e) => { setPassword(e.target.value); loginMut.reset(); }}
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
          Test Connection
        </button>
        {statusQ.data?.logged_in && (
          <span className="flex items-center gap-1 text-sm text-accent">
            <CheckCircle2 className="size-4" /> Logged in
          </span>
        )}
      </div>
      <ProviderFeedback name="ThePosterDB" pending={loginMut.isPending} error={loginMut.error?.message}
        result={loginMut.data ? { ok: loginMut.data.logged_in, message: loginMut.data.message } : statusQ.data?.message ? { ok: statusQ.data.logged_in, message: statusQ.data.message } : undefined} />
      </ProviderConnection>
        <DeviantArtConnection />
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
          configurationError={settingsQ.isError}
          onAutoSave={(kind) => saveMut.mutate(kind)}
        />
    </>
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
  configurationError,
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
  configurationError: boolean;
  onAutoSave: (kind: "fanart" | "tvdb" | "comicvine") => void;
}) {

  const fanartTestMut = useMutation({
    mutationFn: () => api.testArtworkProvider({ provider: "fanart", fanart_api_key: fanart }),
  });

  const tvdbTestMut = useMutation({
    mutationFn: () =>
      api.testArtworkProvider({
        provider: "tvdb",
        tvdb_api_key: tvdbKey || undefined,
        tvdb_pin: tvdbPin || undefined,
      }),
  });
  const comicvineTestMut = useMutation({
    mutationFn: () => api.testArtworkProvider({ provider: "comicvine", comicvine_api_key: comicvine }),
  });

  return (
    <>
      <ProviderConnection id="fanart" name="Fanart.tv" description="Artwork" status={configurationError ? "Configuration unavailable" : providerStatus(cfg?.fanart_configured, fanartTestMut.isPending, fanartTestMut.data, fanartTestMut.error)} setupUrl="https://fanart.tv/get-an-api-key/">
        <Field label="Fanart.tv API Key">
          <input
            className={compactInputCls}
            type="password"
            value={fanart}
            onChange={(e) => { setFanart(e.target.value); fanartTestMut.reset(); }}
            placeholder={cfg?.fanart_configured ? "••••••" : "your Fanart.tv personal API Key"}
            onBlur={() => { if (fanart) onAutoSave("fanart"); }}
          />
        </Field>
        <button
          onClick={() => fanartTestMut.mutate()}
          disabled={fanartTestMut.isPending || (!fanart && !cfg?.fanart_configured)}
          className="mt-2 flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-muted transition-colors hover:text-white disabled:opacity-50"
        >
          {fanartTestMut.isPending ? <Loader2 className="size-4 animate-spin" /> : <PlugZap className="size-4" />}
          Test Connection
        </button>
        <ProviderFeedback name="Fanart.tv" pending={fanartTestMut.isPending} result={fanartTestMut.data} error={fanartTestMut.error?.message} />
      </ProviderConnection>

      <ProviderConnection id="tvdb" name="TheTVDB" description="TV artwork and metadata" status={configurationError ? "Configuration unavailable" : providerStatus(cfg?.tvdb_configured, tvdbTestMut.isPending, tvdbTestMut.data, tvdbTestMut.error)} setupUrl="https://thetvdb.com/dashboard/account/apikey">
        <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2">
          <Field label="TheTVDB API Key">
            <input
              className={compactInputCls}
              type="password"
              value={tvdbKey}
              onChange={(e) => { setTvdbKey(e.target.value); tvdbTestMut.reset(); }}
              placeholder={cfg?.tvdb_configured ? "••••••" : "TheTVDB v4 API Key"}
              onBlur={() => { if (tvdbKey) onAutoSave("tvdb"); }}
            />
          </Field>
          <Field label="TheTVDB Subscriber PIN (Optional)">
            <input
              className={compactInputCls}
              value={tvdbPin}
              onChange={(e) => { setTvdbPin(e.target.value); tvdbTestMut.reset(); }}
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
          Test Connection
        </button>
        <ProviderFeedback name="TheTVDB" pending={tvdbTestMut.isPending} result={tvdbTestMut.data} error={tvdbTestMut.error?.message} />
      </ProviderConnection>
      <ProviderConnection id="comicvine" name="ComicVine" description="Comics metadata" status={configurationError ? "Configuration unavailable" : providerStatus(cfg?.comicvine_configured, comicvineTestMut.isPending, comicvineTestMut.data, comicvineTestMut.error)} setupUrl="https://comicvine.gamespot.com/api/">
        <Field label="ComicVine API Key">
          <input className={compactInputCls} type="password" value={comicvine} onChange={(e) => { setComicvine(e.target.value); comicvineTestMut.reset(); }} placeholder={cfg?.comicvine_configured ? "••••••" : "your ComicVine API Key"} onBlur={() => { if (comicvine) onAutoSave("comicvine"); }} />
        </Field>
        <button onClick={() => comicvineTestMut.mutate()} disabled={comicvineTestMut.isPending || (!comicvine && !cfg?.comicvine_configured)} className="mt-2 flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-muted transition-colors hover:text-white disabled:opacity-50">
          {comicvineTestMut.isPending ? <Loader2 className="size-4 animate-spin" /> : <PlugZap className="size-4" />} Test Connection
        </button>
        <ProviderFeedback name="ComicVine" pending={comicvineTestMut.isPending} result={comicvineTestMut.data} error={comicvineTestMut.error?.message} />
      </ProviderConnection>
      <NativeProviderCredentials />
    </>
  );
}

function ProviderFeedback({ name, pending, result, error }: {
  name: string; pending: boolean; result?: { ok: boolean; message: string }; error?: string;
}) {
  if (!pending && !result && !error) return null;
  const failed = !pending && (Boolean(error) || result?.ok === false);
  return <p role="status" aria-live="polite" aria-atomic="true" className={`mt-3 break-words text-sm ${failed ? "text-danger" : "text-accent"}`}>
    <span className="font-medium">{name}: {pending ? "Testing connection…" : failed ? "Connection failed. " : "Connection successful. "}</span>
    {!pending && (error || result?.message)}
  </p>;
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
      aria-label={title}
      className={`grid size-11 shrink-0 place-items-center rounded-lg border border-border transition-colors ${
        danger ? "text-muted hover:border-danger hover:text-danger" : "text-muted hover:text-white"
      }`}
    >
      {children}
    </button>
  );
}

function DeviantArtConnection() {
  const client = useQueryClient();
  const settings = useQuery({ queryKey: ["artwork-settings"], queryFn: api.getArtworkSettings });
  const [id, setId] = useState("");
  const [secret, setSecret] = useState("");
  const save = useMutation({
    mutationFn: () => api.setArtworkSettings({ deviantart_client_id: id.trim() || undefined, deviantart_client_secret: secret || undefined }),
    onSuccess: () => { setId(""); setSecret(""); client.invalidateQueries({queryKey:["artwork-settings"]}); client.invalidateQueries({queryKey:["artwork-providers"]}); client.invalidateQueries({queryKey:["artwork", "deviantart"]}); reportSettingsSave("saved"); },
    onError: () => reportSettingsSave("error"),
  });
  const test = useMutation({ mutationFn: () => api.testArtworkProvider({provider:"deviantart", deviantart_client_id:id.trim() || undefined, deviantart_client_secret:secret || undefined}) });
  return <ProviderConnection id="deviantart" name="DeviantArt" description="Public artwork search by tag" setupUrl="https://www.deviantart.com/developers/apps" status={providerStatus(settings.data?.deviantart_configured, test.isPending, test.data, test.error)}>
    <p className="mb-3 text-xs text-faint">Register a confidential application to obtain a client ID and secret. Credentials stay on the PosterView server.</p>
    <label className="block text-sm text-muted">Client ID<input className={compactInputCls} value={id} onChange={e=>{setId(e.target.value);test.reset();}} placeholder={settings.data?.deviantart_configured ? "Saved (enter to replace)" : "DeviantArt client ID"}/></label>
    <label className="mt-2 block text-sm text-muted">Client secret<input type="password" autoComplete="new-password" className={compactInputCls} value={secret} onChange={e=>{setSecret(e.target.value);test.reset();}} placeholder={settings.data?.deviantart_configured ? "••••••" : "DeviantArt client secret"}/></label>
    <div className="mt-3 flex gap-2"><button className="rounded-lg bg-accent px-3 py-2 text-sm text-black disabled:opacity-50" disabled={save.isPending || (!id && !secret)} onClick={()=>save.mutate()}>Save credentials</button><button className="rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-50" disabled={test.isPending || (!settings.data?.deviantart_configured && (!id || !secret))} onClick={()=>test.mutate()}>Test Connection</button></div>
    {save.error && <p role="alert" className="mt-2 text-xs text-danger">{save.error.message}</p>}
    <ProviderFeedback name="DeviantArt" pending={test.isPending} result={test.data} error={test.error?.message}/>
  </ProviderConnection>;
}
