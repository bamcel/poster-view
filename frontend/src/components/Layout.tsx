import {useQuery} from "@tanstack/react-query";
import {nativeLibraries} from "../api/nativeLibraries";
// App chrome: a left sidebar (logo, nav, active-server picker) + routed content.

import { NavLink, Outlet, useLocation } from "react-router-dom";
import { LayoutDashboard, Server, HardDrive, Image, Database, Palette, KeyRound, Home, Film, BookOpen, Tv, History, LogOut, Settings, } from "lucide-react";
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
  const location = useLocation();
  const libraries=useQuery({queryKey:["native-libraries"],queryFn:nativeLibraries.list,enabled:!preview});
  const previewNavigate = useLibraryNavigate();
  const showSignOut = useContext(AuthSessionContext)?.password_required !== false && !preview;
  const [panelSolid, setPanelSolid] = useState(panelSolidity);
  const [panelBlur, setPanelBlur] = useState(backdropBlur);
  const [panelOverlayStrength, setPanelOverlayStrength] = useState(panelOverlay);

  const navigationItems = [
    { to: "/", label: "Home", icon: Home, end: true },
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
        <NavLink to="/" aria-label="Go to Home" className="mr-auto min-w-0">
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
      {!preview && <details className="shrink-0 bg-sidebar px-4 py-2 md:hidden"><summary className="text-sm text-muted">Media</summary><nav className="flex flex-col gap-2 py-3">{libraries.data?.map(library=><NavLink key={library.id} to={`/media/${encodeURIComponent(library.id)}`} className="rounded-md bg-elevated px-3 py-2 text-sm">{library.name}</NavLink>)}</nav></details>}
      {!preview && location.pathname.startsWith("/settings") && <details className="shrink-0 bg-sidebar px-4 py-2 md:hidden"><summary className="text-sm text-muted">Settings pages</summary><nav className="grid grid-cols-2 gap-2 py-3">{[["","Dashboard"],["servers","Integrations"],["libraries","Libraries"],["sources","Search Providers"],["database","Database"],["appearance","Appearance"],["security","Privacy / Security"]].map(([section,label])=><NavLink key={section} to={`/settings${section ? `/${section}` : ""}`} className="rounded-md bg-elevated px-3 py-2 text-xs">{label}</NavLink>)}</nav></details>}

      <aside
        className="relative z-20 hidden w-[14.75rem] shrink-0 flex-col overflow-y-auto border-r border-border px-3 py-5 md:flex"
        style={{ backgroundColor: translucentPanelColor("--color-sidebar", panelSolid, panelOverlayStrength), backdropFilter: `blur(${panelBlur}px)`, WebkitBackdropFilter: `blur(${panelBlur}px)` }}
      >
        <div className="mb-8 px-1">
          <NavLink to="/" aria-label="Go to Home" className="block w-fit">
            <Logo />
          </NavLink>
          <div className="mt-1 whitespace-nowrap text-left text-xs text-faint">Artwork Management Console</div>
        </div>

        <nav className="flex flex-col gap-1.5">
          {navigationItems.slice(0,1).map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `flex h-9 items-center gap-3 rounded-md px-3 text-sm font-medium transition-colors ${
                  (preview ? label === "Home" : isActive)
                    ? "bg-elevated text-white shadow-[inset_3px_0_0_var(--color-accent)]"
                    : "text-muted hover:bg-input-hover hover:text-white"
                }`
              }
            >
              <Icon className="size-[18px]" />
              {label}
            </NavLink>
          ))}
          {!preview && <><h2 className="mt-5 px-3 text-xs font-semibold uppercase tracking-wide text-faint">Media</h2>{libraries.data?.map(library=>{const Icon=library.library_type==="books"?BookOpen:library.library_type==="movies"?Film:Tv;return <NavLink key={library.id} to={`/media/${encodeURIComponent(library.id)}`} className={({isActive})=>`flex h-9 items-center gap-3 rounded-md px-3 text-sm font-medium ${isActive ? "bg-elevated text-white shadow-[inset_3px_0_0_var(--color-accent)]" : "text-muted hover:bg-input-hover hover:text-white"}`}><Icon className="size-[18px]"/><span className="truncate">{library.name}</span></NavLink>;})}{navItems.filter(item=>item.to!=="/settings").map(({to,label,icon:Icon,end})=><NavLink key={to} to={to} end={end} className={({isActive})=>`mt-2 flex h-9 items-center gap-3 rounded-md px-3 text-sm ${isActive?"bg-elevated text-white":"text-muted hover:text-white"}`}><Icon className="size-[18px]"/>{label}</NavLink>)}</>}
          {preview && navItems.map(({to,label,icon:Icon,end})=><NavLink key={to} to={to} end={end} className="flex h-9 items-center gap-3 rounded-md px-3 text-sm text-muted"><Icon className="size-[18px]"/>{label}</NavLink>)}
          {!preview && <><h2 className="mt-5 px-3 text-xs font-semibold uppercase tracking-wide text-faint">Settings</h2>{[{section:"",label:"Dashboard",icon:LayoutDashboard},{section:"servers",label:"Integrations",icon:Server},{section:"libraries",label:"Libraries",icon:HardDrive},{section:"sources",label:"Search Providers",icon:Image},{section:"database",label:"Database",icon:Database},{section:"appearance",label:"Appearance",icon:Palette},{section:"security",label:"Privacy / Security",icon:KeyRound}].map(({section,label,icon:Icon})=><NavLink key={section} to={`/settings${section ? `/${section}` : ""}`} end className={({isActive})=>`flex h-9 items-center gap-3 rounded-md px-3 text-sm font-medium ${isActive ? "bg-elevated text-white shadow-[inset_3px_0_0_var(--color-accent)]" : "text-muted hover:bg-input-hover hover:text-white"}`}><Icon className="size-[18px]"/>{label}</NavLink>)}</>}

        </nav>

        <div className="mt-auto pt-4" />
        {showSignOut && <button type="button" onClick={signOut} className="mb-3 flex h-9 shrink-0 items-center gap-3 rounded-md px-3 text-sm font-medium text-muted transition-colors hover:bg-input-hover hover:text-white">
          <LogOut className="size-[18px]" /> Sign out
        </button>}


      </aside>

      <main className="min-h-0 min-w-0 flex-1 overflow-hidden">
        {children ?? <Outlet />}
      </main>
    </div>
  );
}
