import {QueryClientContext} from "@tanstack/react-query";
import { useCallback, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { LockKeyhole, Loader2 } from "lucide-react";
import { api, type AuthSession } from "../api/client";
import { useIdleSession } from "../lib/useIdleSession";
import { Logo } from "./ui";
import { AuthSessionContext } from "../lib/authContext";
import { initialUsername, rememberUsername, remembersUsername, USERNAME_PREFERENCE_EVENT } from "../lib/rememberUsername";
import LoginBackdrop from "./LoginBackdrop";

export default function AuthGate({ children }: { children: ReactNode }) {
  const queryClient=useContext(QueryClientContext);
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [username, setUsername] = useState(initialUsername);
  const usernameEdited = useRef(false);
  const configuredUsername = useRef<string | null>(null);
  const lastSuccessfulUsername = useRef<string | null>(null);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [session, setSession] = useState<AuthSession | null>(null);
  const revision = useRef(0);
  const identity=useRef<string|null>(null);
  const setupRequired = session?.setup_required === true;
  const expire = useCallback(() => {
    revision.current += 1;
    usernameEdited.current = false;
    if (!remembersUsername()) setUsername("");
    queryClient?.clear();
    window.dispatchEvent(new Event("posterview:account-changed"));
    setSession(null);
    setRememberMe(false);
    setAuthenticated(false);
  }, [queryClient]);
  useIdleSession(authenticated && session?.password_required !== false
    ? session?.idle_timeout_minutes ?? null : null, expire);

  useEffect(() => {
    const changed = () => {
      if (!remembersUsername()) {
        rememberUsername("");
        setUsername("");
      } else {
        const suggested = configuredUsername.current ?? lastSuccessfulUsername.current;
        if (suggested !== null) setUsername(suggested);
      }
    };
    window.addEventListener(USERNAME_PREFERENCE_EVENT, changed);
    return () => window.removeEventListener(USERNAME_PREFERENCE_EVENT, changed);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      const requestedRevision = revision.current;
      void api.authStatus().then((status) => {
        if (cancelled || requestedRevision !== revision.current) return;
        if (status.setup_required && !usernameEdited.current) setUsername("");
        else if(status.accounts_enabled && !usernameEdited.current){
          try { if(!localStorage.getItem("posterview.savedUsername")) setUsername(""); } catch { setUsername(""); }
        }
        if (status.username && !status.accounts_enabled && !status.setup_required) {
          configuredUsername.current = status.username;
          if (remembersUsername() && !usernameEdited.current) setUsername(status.username);
        }
        const nextIdentity=status.user?`${status.user.id}:${status.user.revision}`:null;
        if(identity.current!==null && nextIdentity!==identity.current) { queryClient?.clear(); window.dispatchEvent(new Event("posterview:account-changed")); }
        identity.current=nextIdentity;
        setSession(status);
        setAuthenticated(status.authenticated);
      }).catch(() => {
        if (!cancelled && requestedRevision === revision.current) setAuthenticated(false);
      });
    };
    refresh();
    const timer = window.setInterval(refresh, 15_000);
    const expired = expire;
    window.addEventListener("posterview:unauthorized", expired);
    window.addEventListener("posterview:security-changed", refresh);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener("posterview:unauthorized", expired);
      window.removeEventListener("posterview:security-changed", refresh);
    };
  }, [expire,queryClient]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (setupRequired && (!username.trim() || !displayName.trim())) {
      setError("Enter a username and display name.");
      return;
    }
    if (setupRequired && password.length < 8) {
      setError("Choose a password with at least 8 characters.");
      return;
    }
    if (setupRequired && password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    setSubmitting(true);
    try {
      const status = setupRequired
        ? await api.authSetup(username.trim(), displayName.trim(), password)
        : rememberMe
          ? await api.authLogin(username, password, true)
          : await api.authLogin(username, password);
      usernameEdited.current = false;
      lastSuccessfulUsername.current = username;
      rememberUsername(username);
      revision.current += 1;
      queryClient?.clear();
      identity.current=status.user?`${status.user.id}:${status.user.revision}`:null;
      window.dispatchEvent(new Event("posterview:account-changed"));
      setSession(status);
      setPassword("");
      setConfirmPassword("");
      setAuthenticated(status.authenticated);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : setupRequired ? "Could not create administrator." : "Sign-in failed.");
    } finally {
      setSubmitting(false);
    }
  }

  if (authenticated === null) {
    return <div className="grid h-full place-items-center"><Loader2 className="size-6 animate-spin text-accent" /></div>;
  }
  if (authenticated) return <AuthSessionContext.Provider value={session}>{children}</AuthSessionContext.Provider>;

  return (
    <main className="relative grid h-full overflow-y-auto place-items-center bg-base px-4 py-6">
      {!setupRequired && <LoginBackdrop />}
      <form onSubmit={submit} className="relative z-10 w-full max-w-sm rounded-xl border border-white/10 bg-surface/15 p-6 shadow-xl backdrop-blur-sm">
        <Logo />
        <div className="mt-8 flex items-center gap-3">
          <div className="grid size-10 place-items-center rounded-lg bg-surface-2 text-accent"><LockKeyhole className="size-5" /></div>
          <div>
            <h1 className="font-semibold text-white">{setupRequired ? "Create administrator" : "Sign in"}</h1>
            <p className="text-sm text-muted">{setupRequired
              ? "Create the first administrator account before accessing PosterView."
              : "Enter your PosterView username and password."}</p>
          </div>
        </div>
        <label className="mt-6 block text-sm font-medium text-muted" htmlFor="admin-username">Username</label>
        <input
          id="admin-username"
          name="username"
          type="text"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          autoFocus={!username}
          required
          value={username}
          onChange={(event) => {
            usernameEdited.current = true;
            setUsername(event.target.value);
          }}
          className="mt-2 w-full rounded-lg border border-border bg-input px-3 py-2.5 outline-none focus:border-accent"
        />
        {setupRequired && (
          <>
            <label className="mt-4 block text-sm font-medium text-muted" htmlFor="setup-display-name">Display name</label>
            <input
              id="setup-display-name" name="display_name" autoComplete="name" required
              value={displayName} onChange={event => setDisplayName(event.target.value)}
              className="mt-2 w-full rounded-lg border border-border bg-input px-3 py-2.5 outline-none focus:border-accent"
            />
          </>
        )}
        <label className="mt-4 block text-sm font-medium text-muted" htmlFor="admin-password">Password</label>
        <input
          id="admin-password"
          name="password"
          type="password"
          autoComplete={setupRequired ? "new-password" : "current-password"}
          minLength={setupRequired ? 8 : undefined}
          autoFocus={!!username}
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="mt-2 w-full rounded-lg border border-border bg-input px-3 py-2.5 outline-none focus:border-accent"
        />
        {setupRequired && (
          <>
            <p className="mt-2 text-xs text-muted">Use at least 8 characters. This account can manage all server settings and users.</p>
            <label className="mt-4 block text-sm font-medium text-muted" htmlFor="setup-confirm-password">Confirm password</label>
            <input
              id="setup-confirm-password" type="password" autoComplete="new-password" required minLength={8}
              value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)}
              className="mt-2 w-full rounded-lg border border-border bg-input px-3 py-2.5 outline-none focus:border-accent"
            />
          </>
        )}
        {!setupRequired && <label className="mt-4 flex items-center gap-2 text-sm text-muted"><input type="checkbox" checked={rememberMe} disabled={submitting} onChange={event => setRememberMe(event.target.checked)} className="size-4 accent-accent"/>Remember me (30 days)</label>}
        {error && <p role="alert" className="mt-3 text-sm text-red-400">{error}</p>}
        <button type="submit" disabled={submitting} className="mt-5 flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 font-medium text-black disabled:opacity-60">
          {submitting && <Loader2 className="size-4 animate-spin" />}
          {setupRequired ? "Create administrator" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
