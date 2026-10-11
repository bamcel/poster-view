import SettingsPageFrame,{SETTINGS_BUTTON} from "../components/SettingsPageFrame";
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
  PlugZap,
  Loader2,
  CheckCircle2,
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
import { api } from "../api/client";
import { useToast } from "../lib/toast";
import { Switch } from "../components/ui";
import type { AppearanceSettings } from "../types";
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

type SettingsTab = "plugins" | "artwork" | "libraries" | "sources" | "tasks" | "appearance" | "security";

const LIVE_PREVIEW_KEY = "posterview.appearanceLivePreview";

const TABS: { id: SettingsTab; label: string; icon: ReactNode }[] = [
  { id: "artwork", label: "Artwork", icon: <ImageIcon className="size-4" /> },
  { id: "plugins", label: "Plugins", icon: <ServerIcon className="size-4" /> },
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
  const [artworkOpen,setArtworkOpen]=useState(false);
  const [saveStatus, setSaveStatus] = useState<SettingsSaveStatus>("saved");

  useEffect(() => {
    const update = (event: Event) => setSaveStatus((event as CustomEvent<SettingsSaveStatus>).detail);
    window.addEventListener("posterview:settings-save", update);
    return () => window.removeEventListener("posterview:settings-save", update);
  }, []);

  useEffect(()=>{setSaveStatus("saved");},[tab]);

  if (!previewSection && requestedTab && TABS.some(section => section.id === requestedTab)) return <Navigate replace to={`/settings/${requestedTab}`} />;
  if (!tab) return <ServerSettingsDashboard />;
  const descriptions:Record<SettingsTab,string>={plugins:"Choose a plugin to manage its features and settings.",artwork:"Configure artwork browsing and editing tools.",libraries:"Manage media folders, metadata providers, and artwork.",sources:"Configure provider accounts and test their connections.",tasks:"Review cleanup and schedule application maintenance.",appearance:"Customize your theme, layout, and backgrounds.",security:"Manage sign-in, session, and privacy preferences."};
  return <SettingsPageFrame title={TABS.find(section=>section.id===tab)!.label} description={descriptions[tab]} wide={tab==="appearance"} split={tab==="appearance"} status={tab==="libraries"?<NativeLibraryCount/>:saveStatus!=="saved"?<span className={saveStatus==="error"?"text-danger":"text-accent"}>{saveStatus==="saving"?"Savingâ€¦":"Settings could not be saved."}</span>:undefined}>
          {(tab === "plugins" || tab === "artwork") && <PluginsPage artworkOpen={tab === "artwork" || artworkOpen} onArtworkOpen={()=>setArtworkOpen(true)} onClose={()=>{setArtworkOpen(false);if(tab === "artwork") navigate("/settings/plugins");}}/>}
          {tab === "libraries" && <NativeLibrariesSection />}
          {tab === "sources" && <ArtworkSourcesSection />}
          {tab === "tasks" && <ScheduledTasks/>}
          {tab === "appearance" && <AppearanceSection preview={!!previewSection} />}
          {tab === "security" && <SecuritySection />}
  </SettingsPageFrame>;
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
    <section className="h-full min-h-0 min-w-0 overflow-y-auto pr-2">
      <div className="min-h-full w-full"><div className="mb-4 flex justify-end">        <button type="button" aria-pressed={split} onClick={() => setSplitView(value => !value)} className="hidden shrink-0 items-center gap-2 rounded-lg border border-border bg-button px-3 py-2 text-sm font-medium hover:bg-button-hover xl:flex"><Columns2 className="size-4" />Split View</button></div>
        <div>
          <h2 className="mb-1 flex items-center gap-2 text-lg font-semibold">
            <Palette className="size-5 text-accent" /> Theme
          </h2>
          <p className="mb-3 text-sm text-faint">Select a palette or preview an individual color.</p>
          <div className="rounded-xl border border-border bg-window p-5">
          <div className="flex flex-wrap items-end gap-2">
            <ThemePicker themes={themes} selected={selected} onSelect={choose} />
            <button type="button" onClick={reload} className={`${SETTINGS_BUTTON} shrink-0`}>
              Reload theme
            </button>
          </div>
          </div>
        </div>
<div className="mt-8 border-t border-border pt-6">        <div className="mb-1 flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <LayoutDashboard className="size-5 text-accent" /> Layout &amp; Backgrounds
        </h2>

        </div>
        <p className="mb-3 text-sm text-faint">Adjust backgrounds, panels, and metadata pills across the application.</p>
        <div className="rounded-xl border border-border bg-window p-5">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-white">Show Backdrops</p>
              <p className="mt-1 text-xs text-faint">Show library artwork and selected-series backgrounds.</p>
            </div>
            <Switch label="Show Backdrops" checked={showBackdrops} onChange={() => changeBackdrops(!showBackdrops)} />
          </div>
          <DashboardSlider label="Panel Color" value={panelSolid} suffix="%" min={0} max={100} onChange={changePanelSolid} start="Transparent" end="Solid" />
          <DashboardSlider label="Panel Blur" value={blur} suffix="px" min={0} max={30} step={2} onChange={changeBlur} start="No blur" end="Blurred" />
          <DashboardSlider label="Panel Overlay" value={panelOverlayStrength} suffix="%" min={0} max={95} onChange={changePanelOverlay} start="Light" end="Dark" />
          <DashboardSlider label="Backdrop Overlay" value={backdropOverlayStrength} suffix="%" min={0} max={95} onChange={changeBackdropOverlay} start="Light" end="Dark" />
          <DashboardSlider label="Pill Background" value={pillOpacity} suffix="%" min={0} max={100} onChange={changePillOpacity} start="Transparent" end="Solid" />
          <p className="mt-1 text-xs text-faint">Background opacity for series metadata pills and season episode-count pills. Text and borders stay visible.</p>
          <button type="button" onClick={resetDashboard} className={`${SETTINGS_BUTTON} mt-4`}>Reset to default</button>
        </div>

</div><div className="mt-8 border-t border-border pt-6"><h2 className="text-lg font-semibold">Colors</h2><p className="mb-3 mt-1 text-sm text-muted">Preview colors and save them as a custom theme.</p><div className="rounded-xl border border-border bg-window p-5">          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <ColorLabelPicker theme={previewColors} selected={selectedColor} onSelect={setSelectedColor} />
            <div className="text-xs font-semibold text-muted">
              {THEME_COLOR_OPTIONS.find((option) => option.key === selectedColor)?.label}
              <HexColorPicker label={THEME_COLOR_OPTIONS.find((option) => option.key === selectedColor)!.label} value={selectedColorValue} onChange={updateColor}/>
            </div>
          </div>
          <p className="mt-2 text-xs text-faint">Color changes preview immediately. Save them as a custom theme to keep them.</p>

        <div className="mt-4 border-t border-border pt-4">
          <h2 className="text-lg font-semibold">Custom Theme</h2>
          <p className="mt-1 text-sm text-faint">Save your color changes as a named theme. Expand Advanced to edit theme JSON.</p>
          <details className="group mt-4 rounded-xl border border-border bg-panel">
            <summary aria-label="Toggle JSON Editor" className="flex h-10 cursor-pointer list-none items-center justify-between gap-3 px-4 text-sm font-semibold text-muted outline-none marker:hidden hover:text-white focus-visible:text-white">
              <span>Advanced Â· JSON Editor</span>
              <span className="text-faint transition-transform group-open:rotate-180">âŒ„</span>
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
          <button type="button" onClick={save} className={`${SETTINGS_BUTTON} mr-2 mt-4`}>Save custom theme</button>
          <button type="button" onClick={remove} disabled={!selectedIsCustom} className={`${SETTINGS_BUTTON} mt-2`}>Remove custom theme</button>
          {message && <p role="status" className="mt-3 text-xs text-faint">{message}</p>}
        </div>
</div></div>
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
          <span className="text-faint transition-transform group-open:rotate-180">âŒ„</span>
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

function ArtworkSourcesSection() {
  return (
    <section className="space-y-4">
      <p className="text-sm text-muted">Expand a provider to configure credentials or test its connection. Leave saved key fields blank to keep existing values. Default artwork providers are managed in the Artwork plugin.</p>
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
  return <ProviderConnection id="tmdb" name="TMDB" description="Movie and TV metadata" status={settings.isError ? "Configuration unavailable" : save.isPending ? "Savingâ€¦" : providerStatus(settings.data?.tmdb_configured, test.isPending, test.data, test.error)} setupUrl="https://www.themoviedb.org/settings/api">
    <form onSubmit={event => { event.preventDefault(); if (token.trim() && !save.isPending) save.mutate(token.trim()); }}>
    <p className="mt-1 text-xs text-faint">Used for movie and TV metadata and artwork. Save new credentials before testing the connection.</p>
    <p className="mt-2 text-xs text-muted" role="status">{save.isPending ? "Savingâ€¦" : settings.isLoading ? "Checking configurationâ€¦" : settings.isError ? "Unable to load configuration." : settings.data?.tmdb_configured ? "Token saved" : "Not configured"}</p>
    <div className="mt-3 flex flex-wrap items-end gap-3">
      <label className="min-w-0 flex-1 text-xs font-medium text-muted">TMDB API Read Access Token or API key
        <input type="password" autoComplete="off" className={`${compactInputCls} mt-1 w-full`} value={token} disabled={save.isPending} onBlur={() => { if (token.trim() && !save.isPending) save.mutate(token.trim()); }} onChange={event => { setToken(event.target.value); save.reset(); test.reset(); }} placeholder={settings.data?.tmdb_configured ? "Leave blank to keep saved token" : "Paste API Read Access Token"} />
      </label>
      <button type="button" className={SETTINGS_BUTTON} disabled={!settings.data?.tmdb_configured || test.isPending || save.isPending || !!token.trim()} onClick={() => test.mutate()}>{test.isPending ? "Testingâ€¦" : "Test Connection"}</button>
    </div>
    <p className="mt-2 text-xs text-faint">Accepts a TMDB API Read Access Token or a v3 API key. Changes save automatically when you leave the field.</p>
    {test.data && <p role="status" className={`mt-2 text-sm ${test.data.ok ? "text-green-400" : "text-red-400"}`}>{test.data.message}</p>}
    {test.isError && <p role="alert" className="mt-2 text-sm text-red-400">{test.error.message}</p>}
    {save.isError && <p role="alert" className="mt-2 text-sm text-red-400">{save.error.message}</p>}
  </form></ProviderConnection>;
}

const ARTWORK_DATABASES = [
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
      { label: "Poster", kind: "poster" as const, names: ["anilist", "fanart", "mediux", "posterdb", "tvdb"] },
      { label: "eReader", kind: "ereader" as const, names: ["anilist-manga", "comicvine", "mangadex", "viz"] },
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
            placeholder={configured ? "â€¢â€¢â€¢â€¢â€¢â€¢" : ""}
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
            placeholder={cfg?.fanart_configured ? "â€¢â€¢â€¢â€¢â€¢â€¢" : "your Fanart.tv personal API Key"}
            onBlur={() => { if (fanart) onAutoSave("fanart"); }}
          />
        </Field>
        <button
          onClick={() => fanartTestMut.mutate()}
          disabled={fanartTestMut.isPending || (!fanart && !cfg?.fanart_configured)}
          className={`${SETTINGS_BUTTON} mt-2`}
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
              placeholder={cfg?.tvdb_configured ? "â€¢â€¢â€¢â€¢â€¢â€¢" : "TheTVDB v4 API Key"}
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
          className={`${SETTINGS_BUTTON} mt-2`}
        >
          {tvdbTestMut.isPending ? <Loader2 className="size-4 animate-spin" /> : <PlugZap className="size-4" />}
          Test Connection
        </button>
        <ProviderFeedback name="TheTVDB" pending={tvdbTestMut.isPending} result={tvdbTestMut.data} error={tvdbTestMut.error?.message} />
      </ProviderConnection>
      <ProviderConnection id="comicvine" name="ComicVine" description="Comics metadata" status={configurationError ? "Configuration unavailable" : providerStatus(cfg?.comicvine_configured, comicvineTestMut.isPending, comicvineTestMut.data, comicvineTestMut.error)} setupUrl="https://comicvine.gamespot.com/api/">
        <Field label="ComicVine API Key">
          <input className={compactInputCls} type="password" value={comicvine} onChange={(e) => { setComicvine(e.target.value); comicvineTestMut.reset(); }} placeholder={cfg?.comicvine_configured ? "â€¢â€¢â€¢â€¢â€¢â€¢" : "your ComicVine API Key"} onBlur={() => { if (comicvine) onAutoSave("comicvine"); }} />
        </Field>
        <button onClick={() => comicvineTestMut.mutate()} disabled={comicvineTestMut.isPending || (!comicvine && !cfg?.comicvine_configured)} className={`${SETTINGS_BUTTON} mt-2`}>
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
    <span className="font-medium">{name}: {pending ? "Testing connectionâ€¦" : failed ? "Connection failed. " : "Connection successful. "}</span>
    {!pending && (error || result?.message)}
  </p>;
}



// ---------------------------------------------------------------------------
// Small form helpers
// ---------------------------------------------------------------------------


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
