export const DASHBOARD_BACKDROP_KEY = "posterview.dashboardBackdropEnabled";
export const DASHBOARD_BACKDROP_EVENT = "posterview:dashboard-backdrop";

export function dashboardBackdropEnabled() {
  return localStorage.getItem(DASHBOARD_BACKDROP_KEY) === "true";
}

export function setDashboardBackdropEnabled(enabled: boolean) {
  localStorage.setItem(DASHBOARD_BACKDROP_KEY, String(enabled));
  window.dispatchEvent(new CustomEvent(DASHBOARD_BACKDROP_EVENT, { detail: enabled }));
}
