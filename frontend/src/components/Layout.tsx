// App chrome: a left sidebar (logo, nav, active-server picker) + routed content.

import { NavLink, Outlet } from "react-router-dom";
import { LayoutDashboard, History, LogOut, Settings, } from "lucide-react";
import { Logo } from "./ui";
import { api } from "../api/client";
import { useContext, useEffect, useState, type ReactNode } from "react";
import { useNavigate as useLibraryNavigate } from "../lib/libraryNavigation";
import { AuthSessionContext } from "../lib/authContext";
import { BACKDROP_BLUR_EVENT, PANEL_OVERLAY_EVENT, PANEL_SOLIDITY_EVENT, backdropBlur, panelOverlay, panelSolidity, translucentPanelColor } from "../lib/dashboardSettings";

const navItems = [
  { to: "/history", label: "History", icon: History, end: false },
  { to: "/settings", label: "Settings", icon: Settings, end: false },
];
export default function Layout({ children, preview = false, showPreviewChrome = true }: { children?: ReactNode; preview?: boolean; showPreviewChrome?: boolean }) {
  const previewNavigate = useLibraryNavigate();
  const showSignOut = useContext(AuthSessionContext)?.password_required !== false && !preview;
  const [panelSolid, setPanelSolid] = useState(panelSolidity);
  const [panelBlur, setPanelBlur] = useState(backdropBlur);
  const [panelOverlayStrength, setPanelOverlayStrength] = useState(panelOverlay);

  const navigationItems = [
    { to: "/", label: "Dashboard", icon: LayoutDashboard, end: true },
    ...navItems,
  ];
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
    <div className={`flex h-full flex-col md:flex-row ${preview && !showPreviewChrome ? "[&>aside]:hidden [&>header]:hidden [&>div]:hidden" : ""}`}
      onClickCapture={preview ? event => {
        const anchor = (event.target as Element).closest("a");
        if (!anchor || !event.currentTarget.contains(anchor) || !anchor.closest("aside, header")) return;
        event.preventDefault();
        event.stopPropagation();
        if (anchor.getAttribute("href") === "/") void previewNavigate("/");
      } : undefined}>
      <header className="relative z-20 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-sidebar/90 px-3 backdrop-blur-xl md:hidden">
        <NavLink to="/" aria-label="Go to Dashboard" className="mr-auto min-w-0">
          <Logo className="w-36 overflow-hidden [&>img]:max-w-full [&>img]:translate-y-[5px] sm:w-auto sm:[&>img]:max-w-none" />
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

      <aside
        className="relative z-20 hidden w-[14.75rem] shrink-0 flex-col border-r border-border px-3 py-5 md:flex"
        style={{ backgroundColor: translucentPanelColor("--color-sidebar", panelSolid, panelOverlayStrength), backdropFilter: `blur(${panelBlur}px)`, WebkitBackdropFilter: `blur(${panelBlur}px)` }}
      >
        <div className="mb-8 px-1">
          <NavLink to="/" aria-label="Go to Dashboard" className="block w-fit">
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
                  (preview ? label === "Dashboard" : isActive)
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

        <NavLink to="/settings?tab=servers" className="rounded-lg px-3 py-2 text-sm text-muted hover:bg-white/10 hover:text-white">Server integrations</NavLink>
      </aside>

      <main className="min-h-0 min-w-0 flex-1 overflow-hidden">
        {children ?? <Outlet />}
      </main>
    </div>
  );
}
