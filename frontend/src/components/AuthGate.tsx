import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { LockKeyhole, Loader2 } from "lucide-react";
import { api } from "../api/client";
import { Logo } from "./ui";

export default function AuthGate({ children }: { children: ReactNode }) {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api.authStatus()
      .then((status) => setAuthenticated(status.authenticated))
      .catch(() => setAuthenticated(false));
    const expired = () => setAuthenticated(false);
    window.addEventListener("posterview:unauthorized", expired);
    return () => window.removeEventListener("posterview:unauthorized", expired);
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      await api.authLogin(password);
      setPassword("");
      setAuthenticated(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sign-in failed.");
    } finally {
      setSubmitting(false);
    }
  }

  if (authenticated === null) {
    return <div className="grid h-full place-items-center"><Loader2 className="size-6 animate-spin text-accent" /></div>;
  }
  if (authenticated) return children;

  return (
    <main className="grid h-full place-items-center bg-base px-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-xl border border-border bg-surface p-6 shadow-xl">
        <Logo />
        <div className="mt-8 flex items-center gap-3">
          <div className="grid size-10 place-items-center rounded-lg bg-surface-2 text-accent"><LockKeyhole className="size-5" /></div>
          <div><h1 className="font-semibold text-white">Administrator sign in</h1><p className="text-sm text-muted">Enter your PosterView password.</p></div>
        </div>
        <label className="mt-6 block text-sm font-medium text-muted" htmlFor="admin-password">Password</label>
        <input
          id="admin-password"
          type="password"
          autoComplete="current-password"
          autoFocus
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="mt-2 w-full rounded-lg border border-border bg-input px-3 py-2.5 outline-none focus:border-accent"
        />
        {error && <p role="alert" className="mt-3 text-sm text-red-400">{error}</p>}
        <button type="submit" disabled={submitting} className="mt-5 flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 font-medium text-black disabled:opacity-60">
          {submitting && <Loader2 className="size-4 animate-spin" />} Sign in
        </button>
      </form>
    </main>
  );
}
