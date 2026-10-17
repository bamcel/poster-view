import { useUnsavedSettings } from "../useUnsavedSettings";
import { compactInputCls } from "../formStyles";
import { SETTINGS_BUTTON } from "../../../components/SettingsPageFrame";
import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2 } from "lucide-react";
import NativeProviderCredentials from "../../../components/NativeProviderCredentials";
import { api } from "../../../api/client";
import { useToast } from "../../../lib/toast";
import ProviderConnection, { providerStatus,TestConnectionButton } from "../../../components/ProviderConnection";
import { reportSettingsSave } from "../../../lib/settingsSaveStatus";
export default function ArtworkSourcesSection() {
  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted"><p>Manage connections here. Choose providers and their priority in each library.</p><a href="/settings/libraries" className="text-accent">Manage libraries →</a></div>
      <section aria-labelledby="provider-accounts-heading" className="overflow-hidden rounded-xl border border-border bg-window"><header className="border-b border-border px-5 py-4"><h2 id="provider-accounts-heading" className="font-semibold">Accounts & API keys</h2><p className="mt-1 text-xs text-muted">Open a provider to configure or test its saved connection. Blank fields keep existing credentials.</p></header>
        <TmdbCredentialsFields />
        <ArtworkCredentialsFields />
      </section>
      <section aria-labelledby="automatic-providers-heading" className="rounded-xl border border-border bg-window p-5"><header className="mb-4"><h2 id="automatic-providers-heading" className="font-semibold">Ready to use</h2><p className="mt-1 text-xs text-muted">These sources work without an API key or account setup.</p></header><div className="grid gap-x-8 sm:grid-cols-2 xl:grid-cols-3">
        {[
          { id: "anilist", name: "AniList", description: "Anime artwork", url: "https://anilist.co" },
          { id: "anilist-manga", name: "AniList Manga", description: "Manga artwork and metadata", url: "https://anilist.co" },
          { id: "mediux", name: "MediUX", description: "Movie and TV artwork", url: "https://mediux.pro" },
          { id: "mangadex", name: "MangaDex", description: "Manga covers", url: "https://mangadex.org" },
          { id: "viz", name: "VIZ", description: "Manga covers", url: "https://www.viz.com" },
        ].map(provider => <a key={provider.id} href={provider.url} target="_blank" rel="noreferrer" className="flex items-center justify-between gap-3 border-b border-border py-4 text-sm hover:text-accent"><span><span className="font-medium">{provider.name}</span><span className="mt-1 block text-xs text-muted">{provider.description}</span></span><span aria-hidden="true" className="text-muted">↗</span></a>)}
      </div></section>

    </section>
  );
}

function TmdbCredentialsFields() {
  const [token, setToken] = useState("");
  useUnsavedSettings(!!token);
  const client = useQueryClient();
  const toast = useToast();
  const settings = useQuery({ queryKey: ["artwork-settings"], queryFn: api.getArtworkSettings });
  const test = useMutation({ mutationFn: () => api.testArtworkProvider({ provider: "tmdb" }) });
  const save = useMutation({
    mutationFn: (value: string) => api.setArtworkSettings({ tmdb_access_token: value }),
    onMutate: () => reportSettingsSave("saving"),
    onSuccess: (value, savedToken) => {
      client.setQueryData(["artwork-settings"], value);
      setToken(current => current.trim() === savedToken ? "" : current);
      test.reset();
      reportSettingsSave("saved");
      toast.push("success", "TMDB credentials saved.");
    },
    onError: (error: Error) => {
      reportSettingsSave("error");
      toast.push("error", error.message);
    },
  });
  return <ProviderConnection id="tmdb" name="TMDB" description="Movie and TV metadata" status={settings.isError ? "Configuration unavailable" : save.isPending ? "Saving…" : providerStatus(settings.data?.tmdb_configured, test.isPending, test.data, test.error)} setupUrl="https://www.themoviedb.org/settings/api">
    <form onSubmit={event => { event.preventDefault(); if (token.trim() && !save.isPending) save.mutate(token.trim()); }}>
    <p className="mt-1 text-xs text-faint">Used for movie and TV metadata and artwork. Save new credentials before testing the connection.</p>
    <p className="mt-2 text-xs text-muted" role="status">{save.isPending ? "Saving…" : settings.isLoading ? "Checking configuration…" : settings.isError ? "Unable to load configuration." : settings.data?.tmdb_configured ? "Token saved" : "Not configured"}</p>
    <div className="mt-3 flex flex-wrap items-end gap-3">
      <label className="min-w-0 flex-1 text-xs font-medium text-muted">TMDB API Read Access Token or API key
        <input type="password" autoComplete="off" className={`${compactInputCls} mt-1 w-full`} value={token} disabled={save.isPending} onChange={event => { setToken(event.target.value); save.reset(); test.reset(); }} placeholder={settings.data?.tmdb_configured ? "Leave blank to keep saved token" : "Paste API Read Access Token"} />
      </label>
      <button type="submit" className={SETTINGS_BUTTON} disabled={!token.trim() || save.isPending}>{save.isPending ? "Saving…" : "Save credentials"}</button>
      <button type="button" className={SETTINGS_BUTTON} disabled={!token || save.isPending} onClick={() => { setToken(""); save.reset(); }}>Discard</button>
      <TestConnectionButton pending={test.isPending} disabled={!settings.data?.tmdb_configured || save.isPending || !!token.trim()} onClick={() => test.mutate()}/>
    </div>
    {save.isSuccess && <p role="status" className="mt-2 text-xs text-accent">Credentials saved.</p>}
    <p className="mt-2 text-xs text-faint">Accepts a TMDB API Read Access Token or a v3 API key. Choose Save credentials to apply changes. Blank fields keep saved credentials.</p>
    {test.data && <p role="status" className={`mt-2 text-sm ${test.data.ok ? "text-green-400" : "text-red-400"}`}>{test.data.message}</p>}
    {test.isError && <p role="alert" className="mt-2 text-sm text-red-400">{test.error.message}</p>}
    {save.isError && <p role="alert" className="mt-2 text-sm text-red-400">{save.error.message}</p>}
  </form></ProviderConnection>;
}

const ARTWORK_DATABASES = [
  { name: "posterdb", label: "ThePosterDB" },
  { name: "mangadex", label: "MangaDex" },
  { name: "viz", label: "VIZ" },
  { name: "comicvine", label: "ComicVine" },
  { name: "fanart", label: "Fanart.tv" },
  { name: "tvdb", label: "TheTVDB" },
  { name: "anilist", label: "AniList" },
  { name: "anilist-manga", label: "AniList Manga" },
  { name: "mediux", label: "MediUX" },
];

function DefaultArtworkSourceFields({ kind, names }: { kind: "poster" | "ereader"; names: string[] }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const settingsQ = useQuery({ queryKey: ["artwork-settings"], queryFn: api.getArtworkSettings });
  const saveMut = useMutation({
    mutationFn: (provider: string) => api.setArtworkSettings(
      kind === "poster" ? { default_provider: provider } : { ereader_default_provider: provider },
    ),
    onMutate: () => reportSettingsSave("saving"),
    onSuccess: (settings) => {
      queryClient.setQueryData(["artwork-settings"], settings);
      toast.push("success", `Default ${kind === "poster" ? "poster" : "eReader"} source saved.`);
      reportSettingsSave("saved");
    },
    onError: (e: Error) => {
      reportSettingsSave("error");
      queryClient.invalidateQueries({ queryKey: ["artwork-cache"] });
      toast.push("error", e.message);
    },
  });

  return (
    <label className="flex w-full flex-col gap-1 text-xs font-medium text-muted">
      Default provider
      <select
        title={kind === "poster"
          ? "Opens first whenever you select a movie, series, or collection."
          : "Opens first whenever you select book-related media."}
        className={compactInputCls}
        value={(kind === "poster" ? settingsQ.data?.default_provider : settingsQ.data?.ereader_default_provider) ?? ""}
        onChange={(event) => saveMut.mutate(event.target.value)}
        disabled={settingsQ.isLoading || saveMut.isPending}
      >
        {ARTWORK_DATABASES.filter((source) => names.includes(source.name)).map((source) => (
          <option key={source.name} value={source.name}>{source.label}</option>
        ))}
      </select>
    </label>
  );
}

export function DefaultArtworkSourcesFields({flat=false}:{flat?:boolean}={}) {
  return <div className="grid gap-4 lg:grid-cols-2">
    {[
      { label: "Poster", kind: "poster" as const, names: ["anilist", "fanart", "mediux", "posterdb", "tvdb"] },
      { label: "eReader", kind: "ereader" as const, names: ["anilist-manga", "comicvine", "mangadex", "viz"] },
    ].map(group => <div key={group.kind} role="group" aria-labelledby={`provider-group-${group.kind}`} className={flat ? "min-w-0 border-b border-border pb-5" : "min-w-0 rounded-xl border border-border bg-surface-2 p-4"}>
      <h3 id={`provider-group-${group.kind}`} className="mb-3 text-sm font-semibold">{group.label} providers</h3>
      <DefaultArtworkSourceFields kind={group.kind} names={group.names} />
    </div>)}
  </div>;
}

function ArtworkCredentialsFields() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const statusQ = useQuery({ queryKey: ["posterdb-status"], queryFn: api.posterdbStatus });
  const settingsQ = useQuery({ queryKey: ["artwork-settings"], queryFn: api.getArtworkSettings });

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fanart, setFanart] = useState("");
  const [tvdbKey, setTvdbKey] = useState("");
  const [tvdbPin, setTvdbPin] = useState("");
  const [comicvine, setComicvine] = useState("");
  useUnsavedSettings(!!password || !!fanart || !!tvdbKey || !!tvdbPin || !!comicvine || email !== (statusQ.data?.email ?? ""));

  useEffect(() => {
    if (statusQ.data?.email) setEmail(statusQ.data.email);
  }, [statusQ.data?.email]);

  const saveMut = useMutation({
    mutationFn: async (kind: "posterdb" | "fanart" | "tvdb" | "comicvine") => {
      if (kind === "posterdb") return api.setPosterdbCredentials(email.trim(), password);
      if (kind === "fanart") return api.setArtworkSettings({ fanart_api_key: fanart });
      if (kind === "comicvine") return api.setArtworkSettings({ comicvine_api_key: comicvine });
      return api.setArtworkSettings({
        tvdb_api_key: tvdbKey || undefined,
        tvdb_pin: tvdbPin || undefined,
      });
    },
    onMutate: () => reportSettingsSave("saving"),
    onSuccess: (_, kind) => {
      queryClient.invalidateQueries({ queryKey: ["posterdb-status"] });
      queryClient.invalidateQueries({ queryKey: ["artwork-settings"] });
      queryClient.invalidateQueries({ queryKey: ["artwork-providers"] });
      if (kind === "posterdb") setPassword("");
      if (kind === "fanart") setFanart("");
      if (kind === "tvdb") { setTvdbKey(""); setTvdbPin(""); }
      if (kind === "comicvine") setComicvine("");
      reportSettingsSave("saved");
    },
    onError: (e: Error) => {
      reportSettingsSave("error");
      toast.push("error", e.message);
    },
  });

  const loginMut = useMutation({
    mutationFn: api.posterdbLogin,
    onSuccess: (s) => {
      queryClient.invalidateQueries({ queryKey: ["posterdb-status"] });
      toast.push(s.logged_in ? "success" : "error", s.message || (s.logged_in ? "Logged in." : "Login failed."));
    },
    onError: (e: Error) => toast.push("error", e.message),
  });

  const configured = statusQ.data?.configured;

  return (
    <>
      <ProviderConnection id="posterdb" name="ThePosterDB" description="Posters" status={statusQ.isError ? "Configuration unavailable" : providerStatus(configured, loginMut.isPending, loginMut.data ? { ok: loginMut.data.logged_in } : statusQ.data?.logged_in ? { ok: true } : undefined, loginMut.error)} setupUrl="https://theposterdb.com/register">

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Email / username">
          <input
            className={compactInputCls}
            disabled={saveMut.isPending}
            value={email}
            onChange={(e) => { setEmail(e.target.value); loginMut.reset(); saveMut.reset(); }}
            placeholder="you@example.com"
          />
        </Field>
        <Field label="Password">
          <input
            className={compactInputCls}
            type="password"
            disabled={saveMut.isPending}
            value={password}
            onChange={(e) => { setPassword(e.target.value); loginMut.reset(); saveMut.reset(); }}
            placeholder={configured ? "••••••" : ""}
          />
        </Field>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" className={SETTINGS_BUTTON} disabled={saveMut.isPending || !password || !email.trim()} onClick={() => saveMut.mutate("posterdb")}>Save credentials</button>
        <button type="button" className={SETTINGS_BUTTON} disabled={saveMut.isPending || (!password && email === (statusQ.data?.email ?? ""))} onClick={() => { setEmail(statusQ.data?.email ?? ""); setPassword(""); saveMut.reset(); }}>Discard</button>
        <TestConnectionButton pending={loginMut.isPending} disabled={!configured || saveMut.isPending || !!password || email !== (statusQ.data?.email ?? "")} onClick={() => loginMut.mutate()}/>
        {statusQ.data?.logged_in && (
          <span className="flex items-center gap-1 text-sm text-accent">
            <CheckCircle2 className="size-4" /> Logged in
          </span>
        )}
      </div>
      {saveMut.variables === "posterdb" && saveMut.isError && <p role="alert" className="text-sm text-danger">{saveMut.error.message}</p>}
      {saveMut.variables === "posterdb" && saveMut.isSuccess && <p role="status" className="text-xs text-accent">Credentials saved.</p>}
      <ProviderFeedback name="ThePosterDB" pending={loginMut.isPending} error={loginMut.error?.message}
        result={loginMut.data ? { ok: loginMut.data.logged_in, message: loginMut.data.message } : statusQ.data?.message ? { ok: statusQ.data.logged_in, message: statusQ.data.message } : undefined} />
      </ProviderConnection>
        <FanartTvdbFields
          fanart={fanart}
          setFanart={value => { setFanart(value); saveMut.reset(); }}
          tvdbKey={tvdbKey}
          setTvdbKey={value => { setTvdbKey(value); saveMut.reset(); }}
          tvdbPin={tvdbPin}
          setTvdbPin={value => { setTvdbPin(value); saveMut.reset(); }}
          comicvine={comicvine}
          setComicvine={value => { setComicvine(value); saveMut.reset(); }}
          configured={settingsQ.data}
          configurationError={settingsQ.isError}
          onSave={(kind) => saveMut.mutate(kind)}
          saving={saveMut.isPending}
          savedKind={saveMut.isSuccess ? saveMut.variables : undefined}
          saveError={saveMut.isError ? saveMut.error.message : undefined}
        />
    </>
  );
}

function FanartTvdbFields({
  fanart,
  setFanart,
  tvdbKey,
  setTvdbKey,
  tvdbPin,
  setTvdbPin,
  comicvine,
  setComicvine,
  configured: cfg,
  configurationError,
  onSave, saving, savedKind, saveError,
}: {
  fanart: string;
  setFanart: (value: string) => void;
  tvdbKey: string;
  setTvdbKey: (value: string) => void;
  tvdbPin: string;
  setTvdbPin: (value: string) => void;
  comicvine: string;
  setComicvine: (value: string) => void;
  configured?: { fanart_configured: boolean; tvdb_configured: boolean; comicvine_configured: boolean };
  configurationError: boolean;
  saving: boolean;
  savedKind?: string;
  saveError?: string;
  onSave: (kind: "fanart" | "tvdb" | "comicvine") => void;
}) {

  const fanartTestMut = useMutation({
    mutationFn: () => api.testArtworkProvider({ provider: "fanart", fanart_api_key: fanart }),
  });

  const tvdbTestMut = useMutation({
    mutationFn: () =>
      api.testArtworkProvider({
        provider: "tvdb",
        tvdb_api_key: tvdbKey || undefined,
        tvdb_pin: tvdbPin || undefined,
      }),
  });
  const comicvineTestMut = useMutation({
    mutationFn: () => api.testArtworkProvider({ provider: "comicvine", comicvine_api_key: comicvine }),
  });

  return (
    <>
      {saveError && <p role="alert" className="text-sm text-danger">{saveError}</p>}
      <ProviderConnection id="fanart" name="Fanart.tv" description="Artwork" status={configurationError ? "Configuration unavailable" : providerStatus(cfg?.fanart_configured, fanartTestMut.isPending, fanartTestMut.data, fanartTestMut.error)} setupUrl="https://fanart.tv/get-an-api-key/">
        <Field label="Fanart.tv API Key">
          <input
            className={compactInputCls}
            type="password"
            disabled={saving}
            value={fanart}
            onChange={(e) => { setFanart(e.target.value); fanartTestMut.reset(); }}
            placeholder={cfg?.fanart_configured ? "••••••" : "your Fanart.tv personal API Key"}
          />
        </Field>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" className={SETTINGS_BUTTON} disabled={saving || !(!!fanart)} onClick={() => onSave("fanart")}>Save credentials</button>
          <button type="button" className={SETTINGS_BUTTON} disabled={saving || !(!!fanart)} onClick={() => { setFanart(""); }}>Discard</button>
          {savedKind === "fanart" && <span role="status" className="text-xs text-accent">Credentials saved.</span>}
        </div>
        <TestConnectionButton pending={fanartTestMut.isPending} disabled={saving || !!fanart || !cfg?.fanart_configured} onClick={() => fanartTestMut.mutate()}/>
        <ProviderFeedback name="Fanart.tv" pending={fanartTestMut.isPending} result={fanartTestMut.data} error={fanartTestMut.error?.message} />
      </ProviderConnection>

      <ProviderConnection id="tvdb" name="TheTVDB" description="TV artwork and metadata" status={configurationError ? "Configuration unavailable" : providerStatus(cfg?.tvdb_configured, tvdbTestMut.isPending, tvdbTestMut.data, tvdbTestMut.error)} setupUrl="https://thetvdb.com/dashboard/account/apikey">
        <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2">
          <Field label="TheTVDB API Key">
            <input
              className={compactInputCls}
              type="password"
              disabled={saving}
              value={tvdbKey}
              onChange={(e) => { setTvdbKey(e.target.value); tvdbTestMut.reset(); }}
              placeholder={cfg?.tvdb_configured ? "••••••" : "TheTVDB v4 API Key"}
            />
          </Field>
          <Field label="TheTVDB Subscriber PIN (Optional)">
            <input
              className={compactInputCls}
              disabled={saving}
              value={tvdbPin}
              onChange={(e) => { setTvdbPin(e.target.value); tvdbTestMut.reset(); }}
              placeholder="only for user-supported keys"
            />
          </Field>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" className={SETTINGS_BUTTON} disabled={saving || !(!!tvdbKey || !!tvdbPin)} onClick={() => onSave("tvdb")}>Save credentials</button>
          <button type="button" className={SETTINGS_BUTTON} disabled={saving || !(!!tvdbKey || !!tvdbPin)} onClick={() => { setTvdbKey(""); setTvdbPin(""); }}>Discard</button>
          {savedKind === "tvdb" && <span role="status" className="text-xs text-accent">Credentials saved.</span>}
        </div>
        <TestConnectionButton pending={tvdbTestMut.isPending} disabled={saving || !!tvdbKey || !!tvdbPin || !cfg?.tvdb_configured} onClick={() => tvdbTestMut.mutate()}/>
        <ProviderFeedback name="TheTVDB" pending={tvdbTestMut.isPending} result={tvdbTestMut.data} error={tvdbTestMut.error?.message} />
      </ProviderConnection>
      <ProviderConnection id="comicvine" name="ComicVine" description="Comics metadata" status={configurationError ? "Configuration unavailable" : providerStatus(cfg?.comicvine_configured, comicvineTestMut.isPending, comicvineTestMut.data, comicvineTestMut.error)} setupUrl="https://comicvine.gamespot.com/api/">
        <Field label="ComicVine API Key">
          <input className={compactInputCls} type="password" disabled={saving} value={comicvine} onChange={(e) => { setComicvine(e.target.value); comicvineTestMut.reset(); }} placeholder={cfg?.comicvine_configured ? "••••••" : "your ComicVine API Key"} />
        </Field>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" className={SETTINGS_BUTTON} disabled={saving || !(!!comicvine)} onClick={() => onSave("comicvine")}>Save credentials</button>
          <button type="button" className={SETTINGS_BUTTON} disabled={saving || !(!!comicvine)} onClick={() => { setComicvine(""); }}>Discard</button>
          {savedKind === "comicvine" && <span role="status" className="text-xs text-accent">Credentials saved.</span>}
        </div>
        <TestConnectionButton pending={comicvineTestMut.isPending} disabled={saving || !!comicvine || !cfg?.comicvine_configured} onClick={() => comicvineTestMut.mutate()}/>
        <ProviderFeedback name="ComicVine" pending={comicvineTestMut.isPending} result={comicvineTestMut.data} error={comicvineTestMut.error?.message} />
      </ProviderConnection>
      <NativeProviderCredentials />
    </>
  );
}

function ProviderFeedback({ name, pending, result, error }: {
  name: string; pending: boolean; result?: { ok: boolean; message: string }; error?: string;
}) {
  if (!pending && !result && !error) return null;
  const failed = !pending && (Boolean(error) || result?.ok === false);
  return <p role="status" aria-live="polite" aria-atomic="true" className={`mt-3 break-words text-sm ${failed ? "text-danger" : "text-accent"}`}>
    <span className="font-medium">{name}: {pending ? "Testing connection…" : failed ? "Connection failed. " : "Connection successful. "}</span>
    {!pending && (error || result?.message)}
  </p>;
}



// ---------------------------------------------------------------------------
// Small form helpers
// ---------------------------------------------------------------------------


function Field({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-muted">{label}</span>
      {children}
    </label>
  );
}
