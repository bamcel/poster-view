export const DASHBOARD_BACKDROP_KEY = "posterview.dashboardBackdropEnabled";
export const DASHBOARD_BACKDROP_EVENT = "posterview:dashboard-backdrop";
export const PANEL_SOLIDITY_KEY = "posterview.panelSolidity";
export const PANEL_SOLIDITY_EVENT = "posterview:panel-solidity";
export const BACKDROP_BLUR_KEY = "posterview.backdropBlur";
export const BACKDROP_BLUR_EVENT = "posterview:backdrop-blur";
export const DARK_OVERLAY_KEY = "posterview.darkOverlay";
export const DARK_OVERLAY_EVENT = "posterview:dark-overlay";

export const DEFAULT_BACKDROPS_ENABLED = false;
export const DEFAULT_PANEL_SOLIDITY = 40;
export const DEFAULT_BACKDROP_BLUR = 12;
export const DEFAULT_DARK_OVERLAY = 72;

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

export function darkOverlay() {
  return storedNumber(DARK_OVERLAY_KEY, DEFAULT_DARK_OVERLAY, 0, 95);
}

export function setDarkOverlay(value: number) {
  const next = Math.round(Math.min(95, Math.max(0, value)));
  localStorage.setItem(DARK_OVERLAY_KEY, String(next));
  window.dispatchEvent(new CustomEvent(DARK_OVERLAY_EVENT, { detail: next }));
}

export function backdropOverlayGradients(strength: number) {
  const base = strength / 100;
  return {
    mobile: `linear-gradient(to bottom, rgba(8,9,12,${Math.max(0, base - 0.24)}), rgba(8,9,12,${base}) 45%, rgba(8,9,12,${Math.min(1, base + 0.16)}))`,
    desktop: `linear-gradient(to bottom, rgba(8,9,12,${base}), rgba(8,9,12,${Math.min(1, base + 0.18)}) 45%, rgba(8,9,12,${Math.min(1, base + 0.25)}))`,
  };
}

export function translucentPanelColor(colorVariable: string, solidity: number) {
  return `color-mix(in srgb, var(${colorVariable}) ${solidity}%, transparent)`;
}

export function setDashboardBackdropEnabled(enabled: boolean) {
  localStorage.setItem(DASHBOARD_BACKDROP_KEY, String(enabled));
  window.dispatchEvent(new CustomEvent(DASHBOARD_BACKDROP_EVENT, { detail: enabled }));
}
