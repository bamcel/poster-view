import {confirmUnsavedSettings} from "../features/settings/useUnsavedSettings";
import {LibraryHeaderBackContext,useLibraryHeaderBack} from "../lib/libraryHeaderBack";
import SettingsNavigation from "../features/settings/SettingsNavigation";
import {settingsPath as settingsPagePath,visibleSettingsPages} from "../features/settings/navigation";
import GlobalActivityStatus from "../features/activity/GlobalActivityStatus";
import {HeaderBackdropContext,headerBackdropStyle} from "../lib/headerBackdrop";
import {useCatalogPrefetch} from "../lib/catalogPrefetch";
import {HeaderSearchTarget} from "../lib/headerSearch";
import {openDownloadsEvent} from "../features/settings/ytdl/DownloadStatus";
import {resetHomeNavigation} from "../lib/homeNavigation";
import {libraryPath} from "../lib/mediaPaths";
import {useArtworkPlugin} from "../lib/artworkPlugin";
import {virtualTv} from "../features/virtual-tv/client";
import {useQuery,useQueryClient} from "@tanstack/react-query";
import {nativeLibraries} from "../api/nativeLibraries";
// App chrome: contextual media/settings navigation and account controls.

import { NavLink, Outlet, useLocation } from "react-router-dom";
import { LibraryBig, ArrowLeft, Home, Film, BookOpen, Tv, LogOut, Settings, UserRound, } from "lucide-react";
import { Logo } from "./ui";
import { api } from "../api/client";
import { lazy, Suspense, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate as useLibraryNavigate } from "../lib/libraryNavigation";
import { AuthSessionContext, useIsAdmin } from "../lib/authContext";
import { BACKDROP_BLUR_EVENT, PANEL_OVERLAY_EVENT, PANEL_SOLIDITY_EVENT, backdropBlur, panelOverlay, panelSolidity, translucentPanelColor } from "../lib/dashboardSettings";
const DownloadQueuePopup=lazy(()=>import("../features/settings/ytdl/YtdlPlugin").then(module=>({default:module.YtdlPopup})));

export default function Layout({ children, preview = false, showPreviewChrome = true, previewPath = "/" }: { children?: ReactNode; preview?: boolean; showPreviewChrome?: boolean; previewPath?: string }) {
  const queryClient=useQueryClient();
  const location = useLocation();
  const backNavigation=useLibraryHeaderBack();
  const [searchTarget,setSearchTarget]=useState<HTMLDivElement|null>(null);
  const [headerBackdrop,setHeaderBackdrop]=useState<string|null>(null);
  const libraryBack=/^\/media\//.test(preview?previewPath:location.pathname)||/^\/server\/[^/]+\/(item|series)\//.test(preview?previewPath:location.pathname)||/^\/collections\/[^/]+/.test(preview?previewPath:location.pathname);
  const homeSearch=!preview&&location.pathname==="/"&&!new URLSearchParams(location.search).has("lib")&&!new URLSearchParams(location.search).has("native_library");
  const preferencesMenu=useRef<HTMLDetailsElement>(null);
  useEffect(()=>{
    const close=(event:PointerEvent)=>{if(preferencesMenu.current&&!preferencesMenu.current.contains(event.target as Node))preferencesMenu.current.open=false;};
    const escape=(event:KeyboardEvent)=>{if(event.key==="Escape"&&preferencesMenu.current?.open){event.preventDefault();preferencesMenu.current.open=false;preferencesMenu.current.querySelector("summary")?.focus();}};
    document.addEventListener("pointerdown",close);window.addEventListener("keydown",escape);
    return()=>{document.removeEventListener("pointerdown",close);window.removeEventListener("keydown",escape);};
  },[]);
  const artworkPlugin=useArtworkPlugin();
  const virtualTvSettings=useQuery({queryKey:["virtual-tv-settings"],queryFn:virtualTv.settings,enabled:!preview});
  const libraries=useQuery({queryKey:["native-libraries"],queryFn:nativeLibraries.list,enabled:true});
  const prefetchCatalog=useCatalogPrefetch();
  const previewNavigate = useLibraryNavigate();
  const session = useContext(AuthSessionContext);
  const isAdmin=useIsAdmin();
  const [downloadsOpen,setDownloadsOpen]=useState(false);
  useEffect(()=>{
    if(preview||!isAdmin)return;
    const open=()=>setDownloadsOpen(true);
    window.addEventListener(openDownloadsEvent,open);
    return ()=>window.removeEventListener(openDownloadsEvent,open);
  },[preview,isAdmin]);
  const showSignOut = session?.password_required !== false && !preview;
  const [panelSolid, setPanelSolid] = useState(panelSolidity);
  const [panelBlur, setPanelBlur] = useState(backdropBlur);
  const [panelOverlayStrength, setPanelOverlayStrength] = useState(panelOverlay);
  useEffect(()=>{
    document.documentElement.style.setProperty("--pv-menu-background",translucentPanelColor("--color-surface-2",panelSolid,panelOverlayStrength));
    document.documentElement.style.setProperty("--pv-menu-blur",`${panelBlur}px`);
  },[panelSolid,panelOverlayStrength,panelBlur]);

  const settingsOpen = (preview ? previewPath : location.pathname).split("/")[1] === "settings";
  const settingsPath = isAdmin ? "/settings" : "/settings/playback";

  const navigationItems = [
    { to: "/", label: "Home", icon: Home, end: true },
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
    queryClient.clear();
    window.dispatchEvent(new Event("posterview:account-changed"));
    window.location.assign("/");
  }

  return (
    <div className={`flex h-full ${homeSearch?"flex-row":"flex-col md:flex-row"} ${preview && !showPreviewChrome ? "[&>aside]:hidden [&>div>header]:hidden" : ""}`}
      onClickCapture={event => {
        const anchor = (event.target as Element).closest("a");
        if (!anchor || !event.currentTarget.contains(anchor) ) return;
        const href=anchor.getAttribute("href");
        if(event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
        if(href==="/")resetHomeNavigation();
        if(!preview)return;
        event.preventDefault();
        event.stopPropagation();
        if(href?.startsWith("/")) void previewNavigate(href);
      }}>

      <aside id="app-navigation" aria-label={homeSearch?"Navigation":undefined}
        className={`relative z-20 shrink-0 flex-col overflow-hidden border-r border-border px-3 py-5 ${homeSearch?"flex w-[min(18rem,42vw)]":`hidden ${settingsOpen?"w-[min(18rem,42vw)]":"w-[14.75rem]"} md:flex`}`}
        style={{ backgroundColor: translucentPanelColor("--color-sidebar", panelSolid, panelOverlayStrength), backdropFilter: `blur(${panelBlur}px)`, WebkitBackdropFilter: `blur(${panelBlur}px)` }}
      >
        <div className="mb-8 shrink-0 px-1">
          <NavLink to="/" aria-label="Go to Home" className="block w-fit">
            <Logo />
          </NavLink>
          <div className="mt-1 whitespace-nowrap text-left text-xs text-faint">Your Library. Your Style.</div>
        </div>

        <nav className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto [&>a]:shrink-0">
          {navigationItems.slice(0,1).map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `flex h-9 items-center gap-3 rounded-md px-3 text-sm font-medium transition-colors ${
                  (preview ? previewPath === to : isActive)
                    ? "bg-elevated text-white shadow-[inset_3px_0_0_var(--color-sidebar-accent)]"
                    : "text-muted hover:bg-input-hover hover:text-white"
                }`
              }
            >
              <Icon className="size-[18px]" />
              {label}
            </NavLink>
          ))}
          {!settingsOpen && <>
          {<><h2 className="mt-5 px-3 text-xs font-semibold uppercase tracking-wide text-faint">Media</h2>{libraries.data?.map(library=>{const Icon=library.library_type==="books"?BookOpen:library.library_type==="movies"?Film:Tv;return <NavLink key={library.id} onMouseEnter={()=>prefetchCatalog(library.id,library.library_type)} onFocus={()=>prefetchCatalog(library.id,library.library_type)} to={preview ? `/media/${encodeURIComponent(library.id)}` : libraryPath(library,libraries.data??[])} className={({isActive})=>`flex h-9 items-center gap-3 rounded-md px-3 text-sm font-medium ${(preview ? previewPath === `/media/${encodeURIComponent(library.id)}` : isActive) ? "bg-elevated text-white shadow-[inset_3px_0_0_var(--color-sidebar-accent)]" : "text-muted hover:bg-input-hover hover:text-white"}`}><Icon className="size-[18px]"/><span className="truncate">{library.name}</span></NavLink>;})}</>}
          {!preview&&<NavLink to="/collections" className={({isActive})=>`flex h-9 items-center gap-3 rounded-md px-3 text-sm font-medium ${isActive?"bg-elevated text-white":"text-muted hover:bg-input-hover hover:text-white"}`}><LibraryBig className="size-[18px]"/>Collections</NavLink>}
          {!preview&&virtualTvSettings.data?.enabled&&<NavLink to="/virtual-tv" className={({isActive})=>`flex h-9 items-center gap-3 rounded-md px-3 text-sm font-medium ${isActive?"bg-elevated text-white":"text-muted hover:bg-input-hover hover:text-white"}`}><Tv className="size-[18px]"/>Virtual TV</NavLink>}
          </>}

          {settingsOpen && <SettingsNavigation admin={isAdmin} pinned={!!artworkPlugin.data?.pinned} previewPath={preview?previewPath:undefined}/>}

        </nav>

        <div className="mt-auto max-h-[40%] shrink-0 overflow-y-auto pt-4">{!preview&&<GlobalActivityStatus/>}</div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col" style={!preview&&location.pathname==="/virtual-tv"&&headerBackdrop?headerBackdropStyle(headerBackdrop):undefined}>
      <header className={`relative z-20 flex shrink-0 items-center gap-2 bg-transparent px-3 ${homeSearch?"min-h-14 flex-wrap sm:h-14 sm:flex-nowrap":"h-14"}`}>
        {libraryBack&&<NavLink to={backNavigation.target} replace={!backNavigation.hasPrevious} aria-label="Back" title="Back" onClick={event=>{if(!preview&&backNavigation.hasPrevious&&event.button===0&&!event.ctrlKey&&!event.metaKey&&!event.shiftKey&&!event.altKey){event.preventDefault();void previewNavigate(-1);}}} className="grid size-11 shrink-0 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-white focus-visible:outline-2 focus-visible:outline-accent"><ArrowLeft className="size-[20px]" aria-hidden="true"/></NavLink>}
        <NavLink to="/" aria-label="Go to Home" className="mr-auto min-w-0 md:hidden">
          <Logo className="w-20 overflow-hidden [&>img]:max-w-full [&>img]:translate-y-[5px] sm:w-36" />
        </NavLink>
        <nav className="flex items-center gap-1 md:hidden" aria-label="Primary navigation">
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
        <div ref={setSearchTarget} className={homeSearch?"order-last min-w-0 basis-full pb-2 sm:order-none sm:flex-1 sm:basis-auto sm:pb-0":libraryBack?"flex min-w-0 flex-1 justify-center":"hidden"}/>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <details ref={preferencesMenu} className="relative">
            <summary aria-label="Profile" title="Profile" className="pv-profile-trigger grid size-10 cursor-pointer list-none place-items-center text-white [&::-webkit-details-marker]:hidden">
              <UserRound className="size-4" />
            </summary>
            <div className="pv-profile-menu absolute right-0 top-full mt-2 w-60 p-3 shadow-xl">
              <p className="font-medium">{session?.user?.display_name ?? "Profile"}</p>
              <p className="mt-1 text-xs text-muted">{session?.user ? (isAdmin ? "Administrator" : "User") : "Local session"}</p>
              <nav aria-label="Profile settings" className="mt-3 border-t border-border pt-2">
                <NavLink to={settingsPath} onClick={()=>{if(preferencesMenu.current)preferencesMenu.current.open=false;}} className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted hover:bg-input-hover hover:text-white"><Settings className="size-4"/>Settings</NavLink>
                <NavLink to="/settings/playback" onClick={()=>{if(preferencesMenu.current)preferencesMenu.current.open=false;}} className="block rounded-lg px-3 py-2 text-sm text-muted hover:bg-input-hover hover:text-white">Playback preferences</NavLink>
                <NavLink to="/settings/reading" onClick={()=>{if(preferencesMenu.current)preferencesMenu.current.open=false;}} className="block rounded-lg px-3 py-2 text-sm text-muted hover:bg-input-hover hover:text-white">Reading preferences</NavLink>
              </nav>
              {showSignOut && <button type="button" onClick={signOut} className="mt-3 flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-muted hover:bg-input-hover hover:text-white"><LogOut className="size-[18px]" />Sign out</button>}
            </div>
          </details>

        </div>
      </header>
      {!preview && !settingsOpen && <details className="shrink-0 bg-sidebar px-4 py-2 md:hidden"><summary className="text-sm text-muted">Media</summary><nav className="flex flex-col gap-2 py-3">{libraries.data?.map(library=><NavLink key={library.id} onMouseEnter={()=>prefetchCatalog(library.id,library.library_type)} onFocus={()=>prefetchCatalog(library.id,library.library_type)} to={preview ? `/media/${encodeURIComponent(library.id)}` : libraryPath(library,libraries.data??[])} className="rounded-md bg-elevated px-3 py-2 text-sm">{library.name}</NavLink>)}</nav></details>}
      {!preview && settingsOpen && <div className="shrink-0 border-b border-border bg-sidebar px-4 py-2 md:hidden"><label className="flex items-center gap-3 text-sm text-muted">Settings<select aria-label="Settings page" value={location.pathname.split("/")[2]??""} onChange={event=>{if(confirmUnsavedSettings())void previewNavigate(settingsPagePath(event.target.value));else event.target.value=location.pathname.split("/")[2]??"";}} className="min-w-0 flex-1 rounded-lg border border-border bg-input px-3 py-2 text-white">{[...new Set(visibleSettingsPages(isAdmin,!!artworkPlugin.data?.pinned).map(page=>page.group))].map(group=><optgroup key={group} label={group}>{visibleSettingsPages(isAdmin,!!artworkPlugin.data?.pinned).filter(page=>page.group===group).map(page=><option key={page.id} value={page.id}>{page.title}</option>)}</optgroup>)}</select></label></div>}

      {!preview&&!settingsOpen&&virtualTvSettings.data?.enabled&&<NavLink to="/virtual-tv" className="flex shrink-0 items-center gap-2 bg-sidebar px-4 py-2 text-sm md:hidden"><Tv className="size-4"/>Virtual TV</NavLink>}
      <main className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <HeaderBackdropContext.Provider value={setHeaderBackdrop}><HeaderSearchTarget.Provider value={homeSearch||libraryBack?searchTarget:null}><LibraryHeaderBackContext.Provider value={libraryBack}>{children ?? <Outlet />}</LibraryHeaderBackContext.Provider></HeaderSearchTarget.Provider></HeaderBackdropContext.Provider>
      </main>
      {!preview&&isAdmin&&downloadsOpen&&<Suspense fallback={null}><DownloadQueuePopup initialTab="Queue" onClose={()=>setDownloadsOpen(false)}/></Suspense>}
      </div>
    </div>
  );
}
