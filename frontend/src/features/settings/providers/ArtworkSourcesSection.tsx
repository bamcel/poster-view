import { compactInputCls } from "../formStyles";
import { SETTINGS_BUTTON } from "../../../components/SettingsPageFrame";
import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PlugZap, Loader2, CheckCircle2 } from "lucide-react";
import NativeProviderCredentials from "../../../components/NativeProviderCredentials";
import { api } from "../../../api/client";
import { useToast } from "../../../lib/toast";
import ProviderConnection, { providerStatus } from "../../../components/ProviderConnection";
import { reportSettingsSave } from "../../../lib/settingsSaveStatus";
export default function ArtworkSourcesSection() {
  return (
    <section className="space-y-4">
      <p className="text-sm text-muted">Expand a provider to configure credentials or test its connection. Leave saved key fields blank to keep existing values. Default artwork providers are managed in the Artwork plugin.</p>
      <div className="overflow-hidden rounded-xl border border-border">
        <TmdbCredentialsFields />
        <ArtworkCredentialsFields />
        {[
          { id: "anilist", name: "AniList", description: "Anime artwork", url: "https://anilist.co" },
          { id: "anilist-manga", name: "AniList Manga", description: "Manga artwork and metadata", url: "https://anilist.co" },
          { id: "mediux", name: "MediUX", description: "Movie and TV artwork", url: "https://mediux.pro" },
          { id: "mangadex", name: "MangaDex", description: "Manga covers", url: "https://mangadex.org" },
          { id: "viz", name: "VIZ", description: "Manga covers", url: "https://www.viz.com" },
        ].map(provider => <ProviderConnection key={provider.id} id={provider.id} name={provider.name} description={provider.description} status="No credentials required" setupUrl={provider.url} setupLabel="Visit provider">
          <p className="text-sm text-muted">{provider.name} is available automatically. No account or API key is needed for searches.</p>
        </ProviderConnection>)}
      </div>

    </section>
  );
}

function TmdbCredentialsFields() {
  const [token, setToken] = useState("");
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
  return <ProviderConnection id="tmdb" name="TMDB" description="Movie and TV metadata" status={settings.isError ? "Configuration unavailable" : save.isPending ? "Savingâ€¦" : providerStatus(settings.data?.tmdb_configured, test.isPending, test.data, test.error)} setupUrl="https://www.themoviedb.org/settings/api">
    <form onSubmit={event => { event.preventDefault(); if (token.trim() && !save.isPending) save.mutate(token.trim()); }}>
    <p className="mt-1 text-xs text-faint">Used for movie and TV metadata and artwork. Save new credentials before testing the connection.</p>
    <p className="mt-2 text-xs text-muted" role="status">{save.isPending ? "Savingâ€¦" : settings.isLoading ? "Checking configurationâ€¦" : settings.isError ? "Unable to load configuration." : settings.data?.tmdb_configured ? "Token saved" : "Not configured"}</p>
    <div className="mt-3 flex flex-wrap items-end gap-3">
      <label className="min-w-0 flex-1 text-xs font-medium text-muted">TMDB API Read Access Token or API key
        <input type="password" autoComplete="off" className={`${compactInputCls} mt-1 w-full`} value={token} disabled={save.isPending} onBlur={() => { if (token.trim() && !save.isPending) save.mutate(token.trim()); }} onChange={event => { setToken(event.target.value); save.reset(); test.reset(); }} placeholder={settings.data?.tmdb_configured ? "Leave blank to keep saved token" : "Paste API Read Access Token"} />
      </label>
      <button type="button" className={SETTINGS_BUTTON} disabled={!settings.data?.tmdb_configured || test.isPending || save.isPending || !!token.trim()} onClick={() => test.mutate()}>{test.isPending ? "Testingâ€¦" : "Test Connection"}</button>
    </div>
    <p className="mt-2 text-xs text-faint">Accepts a TMDB API Read Access Token or a v3 API key. Changes save automatically when you leave the field.</p>
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
            value={email}
            onChange={(e) => { setEmail(e.target.value); loginMut.reset(); }}
            placeholder="you@example.com"
          />
        </Field>
        <Field label="Password">
          <input
            className={compactInputCls}
            type="password"
            value={password}
            onChange={(e) => { setPassword(e.target.value); loginMut.reset(); }}
            placeholder={configured ? "â€¢â€¢â€¢â€¢â€¢â€¢" : ""}
            onBlur={() => { if (password && email.trim()) saveMut.mutate("posterdb"); }}
          />
        </Field>
      </div>

      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={() => loginMut.mutate()}
          disabled={loginMut.isPending || !configured}
          className="flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-muted transition-colors hover:text-white disabled:opacity-50"
        >
          {loginMut.isPending ? <Loader2 className="size-4 animate-spin" /> : <PlugZap className="size-4" />}
          Test Connection
        </button>
        {statusQ.data?.logged_in && (
          <span className="flex items-center gap-1 text-sm text-accent">
            <CheckCircle2 className="size-4" /> Logged in
          </span>
        )}
      </div>
      <ProviderFeedback name="ThePosterDB" pending={loginMut.isPending} error={loginMut.error?.message}
        result={loginMut.data ? { ok: loginMut.data.logged_in, message: loginMut.data.message } : statusQ.data?.message ? { ok: statusQ.data.logged_in, message: statusQ.data.message } : undefined} />
      </ProviderConnection>
        <FanartTvdbFields
          fanart={fanart}
          setFanart={setFanart}
          tvdbKey={tvdbKey}
          setTvdbKey={setTvdbKey}
          tvdbPin={tvdbPin}
          setTvdbPin={setTvdbPin}
          comicvine={comicvine}
          setComicvine={setComicvine}
          configured={settingsQ.data}
          configurationError={settingsQ.isError}
          onAutoSave={(kind) => saveMut.mutate(kind)}
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
  onAutoSave,
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
  onAutoSave: (kind: "fanart" | "tvdb" | "comicvine") => void;
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
      <ProviderConnection id="fanart" name="Fanart.tv" description="Artwork" status={configurationError ? "Configuration unavailable" : providerStatus(cfg?.fanart_configured, fanartTestMut.isPending, fanartTestMut.data, fanartTestMut.error)} setupUrl="https://fanart.tv/get-an-api-key/">
        <Field label="Fanart.tv API Key">
          <input
            className={compactInputCls}
            type="password"
            value={fanart}
            onChange={(e) => { setFanart(e.target.value); fanartTestMut.reset(); }}
            placeholder={cfg?.fanart_configured ? "â€¢â€¢â€¢â€¢â€¢â€¢" : "your Fanart.tv personal API Key"}
            onBlur={() => { if (fanart) onAutoSave("fanart"); }}
          />
        </Field>
        <button
          onClick={() => fanartTestMut.mutate()}
          disabled={fanartTestMut.isPending || (!fanart && !cfg?.fanart_configured)}
          className={`${SETTINGS_BUTTON} mt-2`}
        >
          {fanartTestMut.isPending ? <Loader2 className="size-4 animate-spin" /> : <PlugZap className="size-4" />}
          Test Connection
        </button>
        <ProviderFeedback name="Fanart.tv" pending={fanartTestMut.isPending} result={fanartTestMut.data} error={fanartTestMut.error?.message} />
      </ProviderConnection>

      <ProviderConnection id="tvdb" name="TheTVDB" description="TV artwork and metadata" status={configurationError ? "Configuration unavailable" : providerStatus(cfg?.tvdb_configured, tvdbTestMut.isPending, tvdbTestMut.data, tvdbTestMut.error)} setupUrl="https://thetvdb.com/dashboard/account/apikey">
        <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2">
          <Field label="TheTVDB API Key">
            <input
              className={compactInputCls}
              type="password"
              value={tvdbKey}
              onChange={(e) => { setTvdbKey(e.target.value); tvdbTestMut.reset(); }}
              placeholder={cfg?.tvdb_configured ? "â€¢â€¢â€¢â€¢â€¢â€¢" : "TheTVDB v4 API Key"}
              onBlur={() => { if (tvdbKey) onAutoSave("tvdb"); }}
            />
          </Field>
          <Field label="TheTVDB Subscriber PIN (Optional)">
            <input
              className={compactInputCls}
              value={tvdbPin}
              onChange={(e) => { setTvdbPin(e.target.value); tvdbTestMut.reset(); }}
              placeholder="only for user-supported keys"
              onBlur={() => { if (tvdbPin) onAutoSave("tvdb"); }}
            />
          </Field>
        </div>
        <button
          onClick={() => tvdbTestMut.mutate()}
          disabled={tvdbTestMut.isPending || (!tvdbKey && !cfg?.tvdb_configured)}
          className={`${SETTINGS_BUTTON} mt-2`}
        >
          {tvdbTestMut.isPending ? <Loader2 className="size-4 animate-spin" /> : <PlugZap className="size-4" />}
          Test Connection
        </button>
        <ProviderFeedback name="TheTVDB" pending={tvdbTestMut.isPending} result={tvdbTestMut.data} error={tvdbTestMut.error?.message} />
      </ProviderConnection>
      <ProviderConnection id="comicvine" name="ComicVine" description="Comics metadata" status={configurationError ? "Configuration unavailable" : providerStatus(cfg?.comicvine_configured, comicvineTestMut.isPending, comicvineTestMut.data, comicvineTestMut.error)} setupUrl="https://comicvine.gamespot.com/api/">
        <Field label="ComicVine API Key">
          <input className={compactInputCls} type="password" value={comicvine} onChange={(e) => { setComicvine(e.target.value); comicvineTestMut.reset(); }} placeholder={cfg?.comicvine_configured ? "â€¢â€¢â€¢â€¢â€¢â€¢" : "your ComicVine API Key"} onBlur={() => { if (comicvine) onAutoSave("comicvine"); }} />
        </Field>
        <button onClick={() => comicvineTestMut.mutate()} disabled={comicvineTestMut.isPending || (!comicvine && !cfg?.comicvine_configured)} className={`${SETTINGS_BUTTON} mt-2`}>
          {comicvineTestMut.isPending ? <Loader2 className="size-4 animate-spin" /> : <PlugZap className="size-4" />} Test Connection
        </button>
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
    <span className="font-medium">{name}: {pending ? "Testing connectionâ€¦" : failed ? "Connection failed. " : "Connection successful. "}</span>
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
