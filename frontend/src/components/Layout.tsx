// App chrome: a left sidebar (logo, nav, active-server picker) + routed content.

import { NavLink, Outlet, useLocation } from "react-router-dom";
import { LayoutDashboard, History, LogOut, Settings, Server as ServerIcon } from "lucide-react";
import { useServers } from "../lib/serverContext";
import { Logo, ServerTypeBadge } from "./ui";
import { api } from "../api/client";
import { useContext, useEffect, useState } from "react";
import { AuthSessionContext } from "../lib/authContext";
import { BACKDROP_BLUR_EVENT, PANEL_OVERLAY_EVENT, PANEL_SOLIDITY_EVENT, backdropBlur, panelOverlay, panelSolidity, translucentPanelColor } from "../lib/dashboardSettings";

const navItems = [
  { to: "/history", label: "History", icon: History, end: false },
  { to: "/settings", label: "Settings", icon: Settings, end: false },
];
const DASHBOARD_LOCATION_PREFIX = "posterview.dashboardLocation.";

export default function Layout() {
  const { servers, selectedId, setSelectedId } = useServers();
  const location = useLocation();
  const showSignOut = useContext(AuthSessionContext)?.password_required !== false;
  const [panelSolid, setPanelSolid] = useState(panelSolidity);
  const [panelBlur, setPanelBlur] = useState(backdropBlur);
  const [panelOverlayStrength, setPanelOverlayStrength] = useState(panelOverlay);
  const [dashboardLocation, setDashboardLocation] = useState(() =>
    selectedId == null
      ? "/"
      : sessionStorage.getItem(`${DASHBOARD_LOCATION_PREFIX}${selectedId}`) || "/",
  );

  useEffect(() => {
    const itemMatch = location.pathname.match(/^\/server\/(\d+)\/item\/[^/]+$/);
    if (itemMatch) {
      const routeServerId = Number(itemMatch[1]);
      const destination = `${location.pathname}${location.search}`;
      sessionStorage.setItem(`${DASHBOARD_LOCATION_PREFIX}${routeServerId}`, destination);
      if (selectedId === routeServerId) setDashboardLocation(destination);
      return;
    }
    if (location.pathname === "/" && selectedId != null) {
      const destination = `/${location.search}`;
      sessionStorage.setItem(`${DASHBOARD_LOCATION_PREFIX}${selectedId}`, destination);
      setDashboardLocation(destination);
      return;
    }
    setDashboardLocation(selectedId == null
      ? "/"
      : sessionStorage.getItem(`${DASHBOARD_LOCATION_PREFIX}${selectedId}`) || "/");
  }, [location.pathname, location.search, selectedId]);

  const navigationItems = [
    { to: dashboardLocation, label: "Dashboard", icon: LayoutDashboard, end: true },
    ...navItems,
  ];
  const openDashboardRoot = () => {
    if (selectedId != null) {
      sessionStorage.removeItem(`posterview.libraryTab.${selectedId}`);
      sessionStorage.setItem(`${DASHBOARD_LOCATION_PREFIX}${selectedId}`, "/");
    }
    setDashboardLocation("/");
  };

  useEffect(() => {
    const updateSolidity = (event: Event) => setPanelSolid((event as CustomEvent<number>).detail);
    const updateBlur = (event: Event) => setPanelBlur((event as CustomEvent<number>).detail);
    const updateOverlay = (event: Event) => setPanelOverlayStrength((event as CustomEvent<number>).detail);
    window.addEventListener(PANEL_SOLIDITY_EVENT, updateSolidity);
    window.addEventListener(BACKDROP_BLUR_EVENT, updateBlur);
    window.addEventListener(PANEL_OVERLAY_EVENT, updateOverlay);
    return () => {
      window.removeEventListener(PANEL_SOLIDITY_EVENT, updateSolidity);
      window.removeEventListener(BACKDROP_BLUR_EVENT, updateBlur);
      window.removeEventListener(PANEL_OVERLAY_EVENT, updateOverlay);
    };
  }, []);

  async function signOut() {
    await api.authLogout();
    window.location.assign("/");
  }

  return (
    <div className="flex h-full flex-col md:flex-row">
      <header className="relative z-20 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-sidebar/90 px-3 backdrop-blur-xl md:hidden">
        <NavLink to="/" onClick={openDashboardRoot} aria-label="Go to Dashboard" className="mr-auto min-w-0">
          <Logo className="w-36 overflow-hidden [&>img]:max-w-full sm:w-auto sm:[&>img]:max-w-none" />
        </NavLink>
        <nav className="flex items-center gap-1" aria-label="Primary navigation">
          {navigationItems.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              aria-label={label}
              className={({ isActive }) =>
                `grid size-11 shrink-0 place-items-center rounded-lg transition-colors ${
                  isActive ? "bg-elevated text-white" : "text-muted hover:bg-surface-2 hover:text-white"
                }`
              }
            >
              <Icon className="size-[18px]" />
            </NavLink>
          ))}
        </nav>
        {showSignOut && <button type="button" onClick={signOut} aria-label="Sign out" className="grid size-11 shrink-0 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-white">
          <LogOut className="size-[18px]" />
        </button>}

      </header>
      <div className="relative z-20 flex min-h-14 shrink-0 items-center gap-3 border-b border-border bg-sidebar/90 px-3 py-2 backdrop-blur-xl md:hidden">
        <span className="shrink-0 text-xs text-faint">Active server</span>
        {servers.length > 0 ? (
          <select
            aria-label="Active server"
            value={selectedId ?? ""}
            onChange={(e) => setSelectedId(Number(e.target.value))}
            className="min-w-0 flex-1 w-full rounded-lg border border-border bg-surface-2 px-2 py-2 text-sm outline-none focus:border-accent"
          >
            {servers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        ) : (
          <NavLink to="/settings" className="rounded-lg border border-border px-2 py-2 text-xs text-muted">
            Add server
          </NavLink>
        )}
      </div>

      <aside
        className="relative z-20 hidden w-[14.75rem] shrink-0 flex-col border-r border-border px-3 py-5 md:flex"
        style={{ backgroundColor: translucentPanelColor("--color-sidebar", panelSolid, panelOverlayStrength), backdropFilter: `blur(${panelBlur}px)`, WebkitBackdropFilter: `blur(${panelBlur}px)` }}
      >
        <div className="mb-8 px-1">
          <NavLink to="/" onClick={openDashboardRoot} aria-label="Go to Dashboard" className="block w-fit">
            <Logo />
          </NavLink>
          <div className="mt-1 whitespace-nowrap text-left text-xs text-faint">Artwork Management Console</div>
        </div>

        <nav className="flex flex-col gap-1.5">
          {navigationItems.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `flex h-9 items-center gap-3 rounded-md px-3 text-sm font-medium transition-colors ${
                  isActive
                    ? "bg-elevated text-white shadow-[inset_3px_0_0_var(--color-accent)]"
                    : "text-muted hover:bg-input-hover hover:text-white"
                }`
              }
            >
              <Icon className="size-[18px]" />
              {label}
            </NavLink>
          ))}
        </nav>

        <div className="mt-auto pt-4" />
        {showSignOut && <button type="button" onClick={signOut} className="mb-3 flex h-9 shrink-0 items-center gap-3 rounded-md px-3 text-sm font-medium text-muted transition-colors hover:bg-input-hover hover:text-white">
          <LogOut className="size-[18px]" /> Sign out
        </button>}

        <div className="min-w-0 overflow-hidden rounded-lg border border-border bg-surface-2 p-3">
          <label className="mb-2 flex items-center gap-2 text-[0.6875rem] font-semibold uppercase tracking-wide text-faint">
            <ServerIcon className="size-3.5" /> Active server
          </label>
          {servers.length === 0 ? (
            <NavLink
              to="/settings"
              className="block rounded-md border border-dashed border-border px-3 py-2 text-center text-xs text-muted hover:border-accent hover:text-white"
            >
              Add a server →
            </NavLink>
          ) : (
            <div className="space-y-2">
              <select
                aria-label="Active server"
                value={selectedId ?? ""}
                onChange={(e) => setSelectedId(Number(e.target.value))}
                className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm outline-none focus:border-accent"
              >
                {servers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              {selectedId != null &&
                (() => {
                  const s = servers.find((x) => x.id === selectedId);
                  return s ? (
                    <div className="flex items-center justify-between px-1">
                      <ServerTypeBadge type={s.type} />
                      <span className="truncate text-[11px] text-faint">{s.base_url}</span>
                    </div>
                  ) : null;
                })()}
            </div>
          )}
        </div>
      </aside>

      <main className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <Outlet />
      </main>
    </div>
  );
}
