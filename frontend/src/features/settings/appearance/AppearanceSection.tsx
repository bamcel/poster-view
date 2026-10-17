import { compactInputCls } from "../formStyles";
import { SETTINGS_BUTTON } from "../../../components/SettingsPageFrame";
import HexColorPicker from "../../../components/HexColorPicker";
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Palette, ChevronDown, LayoutDashboard, Columns2 } from "lucide-react";
import { api } from "../../../api/client";
import { Switch } from "../../../components/ui";
import type { AppearanceSettings } from "../../../types";
import { applyTheme, applyThemePreferences, exportThemePreferences, getAllThemes, getStoredThemeName, getTheme, loadCustomThemes, parseThemeJson, previewTheme, removeCustomTheme, saveCustomTheme, serializeTheme, THEME_COLOR_OPTIONS, type AppTheme, type ThemeColorKey } from "../../../lib/theme";
import AppearancePreview from "../../../components/AppearancePreview";
import { reportSettingsSave } from "../../../lib/settingsSaveStatus";
import { DEFAULT_BACKDROP_BLUR, DEFAULT_BACKDROP_OVERLAY, DEFAULT_BACKDROPS_ENABLED, DEFAULT_PANEL_OVERLAY, DEFAULT_PANEL_SOLIDITY, DEFAULT_PILL_BACKGROUND_OPACITY, pillBackgroundOpacity, setPillBackgroundOpacity, backdropBlur, backdropOverlay, dashboardAppearance, dashboardBackdropEnabled, panelOverlay, panelSolidity, setBackdropBlur, setBackdropOverlay, setDashboardBackdropEnabled, setPanelOverlay, setPanelSolidity } from "../../../lib/dashboardSettings";
const LIVE_PREVIEW_KEY = "posterview.appearanceLivePreview";

export default function AppearanceSection({preview=false}: {preview?:boolean}) {
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
      <div className="min-h-full w-full"><nav aria-label="Appearance sections" className="settings-section-navigation mb-4 flex flex-wrap gap-2">{[["theme","Theme"],["backgrounds","Backgrounds & Panels"],["advanced","Advanced"]].map(([id,label])=><a key={id} href={`#appearance-${id}`} className={SETTINGS_BUTTON}>{label}</a>)}</nav><p className="mb-4 text-xs text-muted">Appearance changes save automatically for all users. Custom color previews are saved with Save custom theme.</p><div className="mb-4 flex justify-end">        <button type="button" aria-pressed={split} onClick={() => setSplitView(value => !value)} className="hidden shrink-0 items-center gap-2 rounded-lg border border-border bg-button px-3 py-2 text-sm font-medium hover:bg-button-hover xl:flex"><Columns2 className="size-4" />Split View</button></div>
        <div id="appearance-theme" className="scroll-mt-4">
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
<div id="appearance-backgrounds" className="scroll-mt-4 mt-8 border-t border-border pt-6">        <div className="mb-1 flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <LayoutDashboard className="size-5 text-accent" /> Backgrounds &amp; Panels
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

</div><div id="appearance-advanced" className="scroll-mt-4 mt-8 border-t border-border pt-6"><h2 className="text-lg font-semibold">Colors</h2><p className="mb-3 mt-1 text-sm text-muted">Preview colors and save them as a custom theme.</p><div className="rounded-xl border border-border bg-window p-5">          <div className="mt-3 grid gap-3 sm:grid-cols-2">
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
              <span>Advanced · JSON Editor</span>
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
