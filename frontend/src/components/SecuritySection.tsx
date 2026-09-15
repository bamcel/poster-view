import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type SecuritySettings } from "../api/client";
import { remembersUsername, setRememberUsername } from "../lib/rememberUsername";
import { reportSettingsSave } from "../lib/settingsSaveStatus";

const LOCAL_BYPASS_WARNING_HIDDEN_KEY = "posterview.localBypassWarningHidden";

export default function SecuritySection() {
  const query = useQuery({ queryKey: ["security-settings"], queryFn: api.securitySettings });
  if (query.isPending) return <p role="status">Loading security settings…</p>;
  if (query.isError) return <p role="alert">Could not load security settings. <button onClick={() => void query.refetch()}>Retry</button></p>;
  return <SecurityForm initial={query.data} />;
}

function SecurityForm({ initial }: { initial: SecuritySettings }) {
  const client = useQueryClient();
  const [autoSignOut, setAutoSignOut] = useState(initial.idle_timeout_minutes !== null);
  const [minutes, setMinutes] = useState(String(initial.idle_timeout_minutes ?? 30));
  const [bypass, setBypass] = useState(initial.local_network_bypass);
  const [backdrop, setBackdrop] = useState(initial.login_backdrop_enabled);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [remember, setRemember] = useState(remembersUsername);
  const [warningHidden, setWarningHidden] = useState(
    () => localStorage.getItem(LOCAL_BYPASS_WARNING_HIDDEN_KEY) === "true",
  );

  const hideWarning = () => {
    localStorage.setItem(LOCAL_BYPASS_WARNING_HIDDEN_KEY, "true");
    setWarningHidden(true);
  };

  const showWarning = () => {
    localStorage.removeItem(LOCAL_BYPASS_WARNING_HIDDEN_KEY);
    setWarningHidden(false);
  };

  const initialRender = useRef(true);
  useEffect(() => {
    if (initialRender.current) {
      initialRender.current = false;
      return;
    }
    const timer = window.setTimeout(async () => {
      setSaving(true); setError(""); reportSettingsSave("saving");
      try {
        const saved = await api.saveSecuritySettings({ idle_timeout_minutes: autoSignOut ? Number(minutes) : null, local_network_bypass: bypass, login_backdrop_enabled: backdrop });
        client.setQueryData(["security-settings"], saved);
        reportSettingsSave("saved");
        window.dispatchEvent(new Event("posterview:security-changed"));
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not save settings.");
        reportSettingsSave("error");
      } finally { setSaving(false); }
    }, 500);
    return () => clearTimeout(timer);
  }, [autoSignOut, backdrop, bypass, client, minutes]);

  return <div className="h-full rounded-2xl border border-border bg-surface p-3">
    <div><h2 className="text-lg font-semibold">Privacy / Security</h2>
      <p className="mt-0.5 text-xs leading-5 text-faint">Session and network settings apply to all users and persist after container restarts. The container’s Require Login option overrides these controls: when false, all connections have password-free access and auto sign-out cannot lock the application.</p></div>
    <div className="mt-2 divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface-2">
    <fieldset className="space-y-1 px-3 py-2.5">
      <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={remember} onChange={(event) => {
        setRemember(event.target.checked);
        setRememberUsername(event.target.checked);
      }} />Remember username on this browser</label>
      <p className="text-xs leading-5 text-faint">Saves immediately on this browser only. Keeps your last successful username filled in on the sign-in screen. Turning this off deletes the saved username. PosterView never stores your login password in browser storage.</p>
    </fieldset>
    <fieldset disabled={saving} className="space-y-1 px-3 py-2.5">
      <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={backdrop} onChange={(event) => setBackdrop(event.target.checked)} />Show library posters on the login page</label>
      <p className="text-xs leading-5 text-faint">Uses cached, resized posters from your connected server. Library names, item names, server addresses, and credentials are never included in the public backdrop feed. Turn this off if artwork would reveal private library content.</p>
    </fieldset>
    <fieldset disabled={saving} className="space-y-1 px-3 py-2.5">
      <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={autoSignOut} onChange={(event) => setAutoSignOut(event.target.checked)} />Automatically sign out when inactive</label>
      <label className="flex flex-wrap items-center gap-2 text-xs text-muted">Minutes of inactivity
        <input aria-label="Minutes of inactivity" type="number" min="1" max="1440" step="1" required disabled={!autoSignOut} value={minutes} onChange={(event) => setMinutes(event.target.value)} className="w-20 rounded-md border border-border bg-input px-2 py-1 text-sm text-white disabled:opacity-50" />
      </label>
      <p className="text-xs leading-5 text-faint">Choose 1–1440 minutes. Mouse, keyboard, touch, and scrolling count as activity; background requests do not. Activity in another open tab keeps the shared session active.</p>
    </fieldset>
    <fieldset disabled={saving} className="space-y-1 px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={bypass} onChange={(event) => setBypass(event.target.checked)} aria-describedby={warningHidden ? undefined : "local-bypass-warning"} />Skip password authentication on local networks</label>
        {warningHidden && <button type="button" onClick={showWarning} className="text-xs text-muted hover:text-white">Show warning</button>}
      </div>
      {!warningHidden && (
        <div id="local-bypass-warning" className="flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-xs leading-5 text-amber-200">
          <p className="min-w-0 flex-1">Warning: Anyone whose connection appears local gets full access without a password. A reverse proxy or Docker networking can make remote visitors appear local too, including visitors using your public domain. Enable only if you accept this risk.</p>
          <button type="button" onClick={hideWarning} className="shrink-0 text-amber-100 underline decoration-amber-300/50 underline-offset-2 hover:text-white">Hide warning</button>
        </div>
      )}
      <p className="text-xs leading-5 text-faint">Uses the direct connection’s private, loopback, or link-local IP address—not the hostname or forwarded headers. Auto sign-out does not lock password-free local access. Turn this off to require a password again. Your existing password is preserved.</p>
    </fieldset>
    </div>
    {error && <p role="alert" className="mt-3 text-sm text-red-400">{error}</p>}
  </div>;
}
