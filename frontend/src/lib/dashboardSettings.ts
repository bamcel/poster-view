export const DASHBOARD_BACKDROP_KEY = "posterview.dashboardBackdropEnabled";
export const LIBRARY_COLLAPSE_EVENT = "posterview:library-collapse";
const LIBRARY_COLLAPSE_KEY = "posterview.libraryTabsCollapsed";
export const DEFAULT_LIBRARY_VISIBLE_COUNT = 5;
export function libraryVisibleCount() {
  return storedNumber("posterview.libraryVisibleCount", DEFAULT_LIBRARY_VISIBLE_COUNT, 1, 30);
}
export function setLibraryVisibleCount(value: number) {
  localStorage.setItem("posterview.libraryVisibleCount", String(Math.round(Math.max(1, Math.min(30, value)))));
  window.dispatchEvent(new CustomEvent(LIBRARY_COLLAPSE_EVENT));
}

export function libraryTabsCollapsed() {
  return localStorage.getItem(LIBRARY_COLLAPSE_KEY) === "true";
}

export function setLibraryTabsCollapsed(enabled: boolean) {
  localStorage.setItem(LIBRARY_COLLAPSE_KEY, String(enabled));
  window.dispatchEvent(new CustomEvent(LIBRARY_COLLAPSE_EVENT));
}
export const DASHBOARD_BACKDROP_EVENT = "posterview:dashboard-backdrop";
export const PANEL_SOLIDITY_KEY = "posterview.panelSolidity";
export const PANEL_SOLIDITY_EVENT = "posterview:panel-solidity";
export const BACKDROP_BLUR_KEY = "posterview.backdropBlur";
export const BACKDROP_BLUR_EVENT = "posterview:backdrop-blur";
export const PANEL_OVERLAY_KEY = "posterview.panelOverlay";
export const PANEL_OVERLAY_EVENT = "posterview:panel-overlay";
export const BACKDROP_OVERLAY_KEY = "posterview.darkOverlay";
export const BACKDROP_OVERLAY_EVENT = "posterview:dark-overlay";

export const DEFAULT_BACKDROPS_ENABLED = false;
export const DEFAULT_PANEL_SOLIDITY = 40;
export const DEFAULT_BACKDROP_BLUR = 12;
export const DEFAULT_PANEL_OVERLAY = 0;
export const DEFAULT_BACKDROP_OVERLAY = 72;

function storedNumber(key: string, fallback: number, minimum: number, maximum: number) {
  const value = Number(localStorage.getItem(key) ?? fallback);
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
}

export function dashboardBackdropEnabled() {
  const stored = localStorage.getItem(DASHBOARD_BACKDROP_KEY);
  return stored == null ? DEFAULT_BACKDROPS_ENABLED : stored === "true";
}

export function panelSolidity() {
  return storedNumber(PANEL_SOLIDITY_KEY, DEFAULT_PANEL_SOLIDITY, 0, 100);
}

export function setPanelSolidity(value: number) {
  const next = Math.round(Math.min(100, Math.max(0, value)));
  localStorage.setItem(PANEL_SOLIDITY_KEY, String(next));
  window.dispatchEvent(new CustomEvent(PANEL_SOLIDITY_EVENT, { detail: next }));
}

export function backdropBlur() {
  return storedNumber(BACKDROP_BLUR_KEY, DEFAULT_BACKDROP_BLUR, 0, 30);
}

export function setBackdropBlur(value: number) {
  const next = Math.round(Math.min(30, Math.max(0, value)));
  localStorage.setItem(BACKDROP_BLUR_KEY, String(next));
  window.dispatchEvent(new CustomEvent(BACKDROP_BLUR_EVENT, { detail: next }));
}

export function panelOverlay() {
  return storedNumber(PANEL_OVERLAY_KEY, DEFAULT_PANEL_OVERLAY, 0, 95);
}

export function setPanelOverlay(value: number) {
  const next = Math.round(Math.min(95, Math.max(0, value)));
  localStorage.setItem(PANEL_OVERLAY_KEY, String(next));
  window.dispatchEvent(new CustomEvent(PANEL_OVERLAY_EVENT, { detail: next }));
}

export function backdropOverlay() {
  return storedNumber(BACKDROP_OVERLAY_KEY, DEFAULT_BACKDROP_OVERLAY, 0, 95);
}

export function setBackdropOverlay(value: number) {
  const next = Math.round(Math.min(95, Math.max(0, value)));
  localStorage.setItem(BACKDROP_OVERLAY_KEY, String(next));
  window.dispatchEvent(new CustomEvent(BACKDROP_OVERLAY_EVENT, { detail: next }));
}

export function backdropOverlayGradients(strength: number) {
  const base = strength / 100;
  return {
    mobile: `linear-gradient(to bottom, rgba(8,9,12,${Math.max(0, base - 0.24)}), rgba(8,9,12,${base}) 45%, rgba(8,9,12,${Math.min(1, base + 0.16)}))`,
    desktop: `linear-gradient(to bottom, rgba(8,9,12,${base}), rgba(8,9,12,${Math.min(1, base + 0.18)}) 45%, rgba(8,9,12,${Math.min(1, base + 0.25)}))`,
  };
}

export function translucentPanelColor(colorVariable: string, solidity: number, overlay = 0) {
  const panel = `color-mix(in srgb, var(${colorVariable}) ${solidity}%, transparent)`;
  return overlay > 0 ? `color-mix(in srgb, ${panel} ${100 - overlay}%, black)` : panel;
}

export function setDashboardBackdropEnabled(enabled: boolean) {
  localStorage.setItem(DASHBOARD_BACKDROP_KEY, String(enabled));
  window.dispatchEvent(new CustomEvent(DASHBOARD_BACKDROP_EVENT, { detail: enabled }));
}

export interface DashboardAppearance {
  library_tabs_collapsed?: boolean;
  library_visible_count?: number;
  backdrops_enabled: boolean;
  panel_solidity: number;
  panel_blur: number;
  panel_overlay: number;
  backdrop_overlay: number;
}

export function dashboardAppearance(): DashboardAppearance {
  return {
    backdrops_enabled: dashboardBackdropEnabled(),
    library_tabs_collapsed: libraryTabsCollapsed(),
    library_visible_count: libraryVisibleCount(),
    panel_solidity: panelSolidity(),
    panel_blur: backdropBlur(),
    panel_overlay: panelOverlay(),
    backdrop_overlay: backdropOverlay(),
  };
}

export function applyDashboardAppearance(settings: DashboardAppearance) {
  setLibraryTabsCollapsed(settings.library_tabs_collapsed ?? false);
  setLibraryVisibleCount(settings.library_visible_count ?? DEFAULT_LIBRARY_VISIBLE_COUNT);
  setDashboardBackdropEnabled(settings.backdrops_enabled);
  setPanelSolidity(settings.panel_solidity);
  setBackdropBlur(settings.panel_blur);
  setPanelOverlay(settings.panel_overlay);
  setBackdropOverlay(settings.backdrop_overlay);
}
