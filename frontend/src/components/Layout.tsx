// App chrome: a left sidebar (logo, nav, active-server picker) + routed content.

import { NavLink, Outlet } from "react-router-dom";
import { LibraryBig, History, LogOut, Settings, Server as ServerIcon } from "lucide-react";
import { useServers } from "../lib/serverContext";
import { Logo, ServerTypeBadge } from "./ui";
import { api } from "../api/client";
import { useContext } from "react";
import { AuthSessionContext } from "../lib/authContext";

const navItems = [
  { to: "/", label: "Libraries", icon: LibraryBig, end: true },
  { to: "/history", label: "History", icon: History, end: false },
  { to: "/settings", label: "Settings", icon: Settings, end: false },
];

export default function Layout() {
  const { servers, selectedId, setSelectedId } = useServers();
  const showSignOut = useContext(AuthSessionContext)?.password_required !== false;

  async function signOut() {
    await api.authLogout();
    window.location.assign("/");
  }

  return (
    <div className="flex h-full flex-col md:flex-row">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-sidebar/95 px-3 backdrop-blur-xl md:hidden">
        <Logo className="mr-auto [&_span:last-child]:hidden min-[390px]:[&_span:last-child]:inline" />
        <nav className="flex items-center gap-1" aria-label="Primary navigation">
          {navItems.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              aria-label={label}
              className={({ isActive }) =>
                `grid size-10 place-items-center rounded-lg transition-colors ${
                  isActive ? "bg-elevated text-white" : "text-muted hover:bg-surface-2 hover:text-white"
                }`
              }
            >
              <Icon className="size-[18px]" />
            </NavLink>
          ))}
        </nav>
        {showSignOut && <button type="button" onClick={signOut} aria-label="Sign out" className="grid size-10 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-white">
          <LogOut className="size-[18px]" />
        </button>}
        {servers.length > 0 ? (
          <select
            aria-label="Active server"
            value={selectedId ?? ""}
            onChange={(e) => setSelectedId(Number(e.target.value))}
            className="min-w-0 max-w-28 rounded-lg border border-border bg-surface-2 px-2 py-2 text-sm outline-none focus:border-accent min-[480px]:max-w-40"
          >
            {servers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        ) : (
          <NavLink to="/settings" className="rounded-lg border border-border px-2 py-2 text-xs text-muted">
            Add server
          </NavLink>
        )}
      </header>

      <aside className="hidden w-[14.75rem] shrink-0 flex-col border-r border-border bg-sidebar px-3 py-5 md:flex">
        <div className="mb-8 px-1">
          <Logo />
          <div className="mt-1 pl-12 text-xs text-faint">Artwork management console</div>
        </div>

        <nav className="flex flex-col gap-1.5">
          {navItems.map(({ to, label, icon: Icon, end }) => (
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
