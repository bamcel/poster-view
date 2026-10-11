import {libraryPath} from "../lib/mediaPaths";
import {useArtworkPlugin} from "../lib/artworkPlugin";
import {useServerConnectPlugin} from "./PluginsPage";
import {useQuery} from "@tanstack/react-query";
import {nativeLibraries} from "../api/nativeLibraries";
// App chrome: a left sidebar (logo, nav, active-server picker) + routed content.

import { NavLink, Outlet, useLocation } from "react-router-dom";
import { LayoutDashboard, Server, HardDrive, Image, Database, Palette, KeyRound, Home, Film, BookOpen, Tv, LogOut, Settings, } from "lucide-react";
import { Logo } from "./ui";
import { api } from "../api/client";
import { useContext, useEffect, useState, type ReactNode } from "react";
import { useNavigate as useLibraryNavigate } from "../lib/libraryNavigation";
import { AuthSessionContext } from "../lib/authContext";
import { BACKDROP_BLUR_EVENT, PANEL_OVERLAY_EVENT, PANEL_SOLIDITY_EVENT, backdropBlur, panelOverlay, panelSolidity, translucentPanelColor } from "../lib/dashboardSettings";

const navItems = [
  { to: "/settings", label: "Settings", icon: Settings, end: false },
];
export default function Layout({ children, preview = false, showPreviewChrome = true, previewPath = "/" }: { children?: ReactNode; preview?: boolean; showPreviewChrome?: boolean; previewPath?: string }) {
  const location = useLocation();
  const artworkPlugin=useArtworkPlugin();
  const serverConnect=useServerConnectPlugin();
  const libraries=useQuery({queryKey:["native-libraries"],queryFn:nativeLibraries.list,enabled:true});
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
        if (!anchor || !event.currentTarget.contains(anchor) ) return;
        event.preventDefault();
        event.stopPropagation();
        const href=anchor.getAttribute("href");
        if(href?.startsWith("/")) void previewNavigate(href);
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
      {!preview && <details className="shrink-0 bg-sidebar px-4 py-2 md:hidden"><summary className="text-sm text-muted">Media</summary><nav className="flex flex-col gap-2 py-3">{libraries.data?.map(library=><NavLink key={library.id} to={preview ? `/media/${encodeURIComponent(library.id)}` : libraryPath(library,libraries.data??[])} className="rounded-md bg-elevated px-3 py-2 text-sm">{library.name}</NavLink>)}</nav></details>}
      {!preview && location.pathname.startsWith("/settings") && <div className="shrink-0 border-b border-border bg-sidebar px-4 py-2 md:hidden"><label className="flex items-center gap-3 text-sm text-muted">Settings<select aria-label="Settings page" value={location.pathname.split("/")[2]??""} onChange={event=>void previewNavigate(`/settings${event.target.value?`/${event.target.value}`:""}`)} className="min-w-0 flex-1 rounded-lg border border-border bg-input px-3 py-2 text-white">{[["","Dashboard"],["plugins","Plugins"],...(serverConnect.data?.pinned?[["servers","Server Connect"]]:[]),...(artworkPlugin.data?.pinned?[["artwork","Artwork"]]:[]),["libraries","Libraries"],["sources","Search Providers"],["tasks","Scheduled Tasks"],["appearance","Appearance"],["security","Privacy / Security"]].map(([section,label])=><option key={section} value={section}>{label}</option>)}</select></label></div>}

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
                  (preview ? previewPath === to : isActive)
                    ? "bg-elevated text-white shadow-[inset_3px_0_0_var(--color-accent)]"
                    : "text-muted hover:bg-input-hover hover:text-white"
                }`
              }
            >
              <Icon className="size-[18px]" />
              {label}
            </NavLink>
          ))}
          {<><h2 className="mt-5 px-3 text-xs font-semibold uppercase tracking-wide text-faint">Media</h2>{libraries.data?.map(library=>{const Icon=library.library_type==="books"?BookOpen:library.library_type==="movies"?Film:Tv;return <NavLink key={library.id} to={preview ? `/media/${encodeURIComponent(library.id)}` : libraryPath(library,libraries.data??[])} className={({isActive})=>`flex h-9 items-center gap-3 rounded-md px-3 text-sm font-medium ${(preview ? previewPath === `/media/${encodeURIComponent(library.id)}` : isActive) ? "bg-elevated text-white shadow-[inset_3px_0_0_var(--color-accent)]" : "text-muted hover:bg-input-hover hover:text-white"}`}><Icon className="size-[18px]"/><span className="truncate">{library.name}</span></NavLink>;})}{navItems.filter(item=>item.to!=="/settings").map(({to,label,icon:Icon,end})=><NavLink key={to} to={to} end={end} className={({isActive})=>`mt-2 flex h-9 items-center gap-3 rounded-md px-3 text-sm ${isActive?"bg-elevated text-white":"text-muted hover:text-white"}`}><Icon className="size-[18px]"/>{label}</NavLink>)}</>}

          {<><h2 className="mt-5 px-3 text-xs font-semibold uppercase tracking-wide text-faint">Settings</h2>{[{section:"",label:"Dashboard",icon:LayoutDashboard},{section:"plugins",label:"Plugins",icon:Server},...(serverConnect.data?.pinned?[{section:"servers",label:"Server Connect",icon:Server}]:[]),...(artworkPlugin.data?.pinned?[{section:"artwork",label:"Artwork",icon:Image}]:[]),{section:"libraries",label:"Libraries",icon:HardDrive},{section:"sources",label:"Search Providers",icon:Image},{section:"tasks",label:"Scheduled Tasks",icon:Database},{section:"appearance",label:"Appearance",icon:Palette},{section:"security",label:"Privacy / Security",icon:KeyRound}].map(({section,label,icon:Icon})=><NavLink key={section} to={`/settings${section ? `/${section}` : ""}`} end className={({isActive})=>`flex h-9 items-center gap-3 rounded-md px-3 text-sm font-medium ${(preview ? previewPath === `/settings${section ? `/${section}` : ""}` : isActive) ? "bg-elevated text-white shadow-[inset_3px_0_0_var(--color-accent)]" : "text-muted hover:bg-input-hover hover:text-white"}`}><Icon className="size-[18px]"/>{label}</NavLink>)}</>}

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
