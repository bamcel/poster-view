import { useContext, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Loader2, RefreshCw, Search, UsersRound } from "lucide-react";
import { creditsApi, type SeriesCredits } from "../api/credits";
import { castGroups, creditProviders, displayCredits, languageName, readCastPreference, type CastPreference, type DisplayCredit } from "../lib/credits";
import { AuthSessionContext } from "../lib/authContext";
import type { ItemDetail } from "../types";

const control = "rounded-lg border border-white/15 bg-surface px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-50";
const safeUrl = (url: string | null) => url?.startsWith("https://") ? url : undefined;

function PersonCard({ credit }: { credit: DisplayCredit }) {
  return <article className="flex min-w-0 gap-3 rounded-xl border border-white/10 bg-black/25 p-3">
    <div className="relative h-20 w-16 shrink-0 overflow-hidden rounded-lg bg-white/10">
      <div className="absolute inset-0 grid place-items-center text-xl text-white/40" aria-hidden="true">{credit.name[0]}</div>
      {safeUrl(credit.image) && <img src={credit.image!} alt="" loading="lazy" referrerPolicy="no-referrer" className="relative h-full w-full object-cover" onError={e => { e.currentTarget.style.visibility = "hidden"; }} />}
    </div>
    <div className="min-w-0 flex-1">
      <p className="text-sm font-semibold leading-snug">{credit.name}</p>
      {credit.character && <p className="mt-1 text-sm text-white/80">{credit.character}</p>}
      <p className="mt-1 text-xs text-white/55">{credit.role}</p>
      {credit.dub_group && <p className="mt-1 text-xs text-amber-200">{credit.dub_group}</p>}
      {credit.notes && <p className="mt-1 text-xs text-white/55">{credit.notes}</p>}
      <div className="mt-2 flex flex-wrap gap-x-2 gap-y-1">{credit.sources.map(source => safeUrl(source.url) ? <a key={source.provider} href={source.url!} target="_blank" rel="noreferrer" className="text-[10px] text-white/50 hover:text-white">{creditProviders[source.provider]} ↗</a> : <span key={source.provider} className="text-[10px] text-white/50">{creditProviders[source.provider]}</span>)}</div>
    </div>
  </article>;
}
function CreditGrid({ credits }: { credits: DisplayCredit[] }) {
  const [expanded, setExpanded] = useState(false);
  return <><div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">{(expanded ? credits : credits.slice(0, 12)).map((credit, i) => <PersonCard key={`${credit.person_id}-${i}`} credit={credit} />)}</div>
    {credits.length > 12 && <button className="mt-3 text-sm text-white/70 hover:text-white" onClick={() => setExpanded(!expanded)}>{expanded ? "Show fewer" : `Show all ${credits.length}`}</button>}</>;
}

export default function CastCrewPanel({ serverId, item }: { serverId: number; item: ItemDetail }) {
  const session = useContext(AuthSessionContext);
  const preferenceKey = `posterview.cast.${session?.username ?? "local"}`;
  const [preference, setPreference] = useState(() => readCastPreference(preferenceKey));
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [provider, setProvider] = useState("anilist");
  const [term, setTerm] = useState(item.title);
  const [search, setSearch] = useState("");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [token, setToken] = useState("");
  const [tab, setTab] = useState<"cast" | "crew">("cast");
  const client = useQueryClient();
  const queryKey = ["series-credits", serverId, item.id];
  const query = useQuery({ queryKey, queryFn: () => creditsApi.get(serverId, item.id), staleTime: 60_000 });
  const settings = useQuery({ queryKey: ["credit-settings"], queryFn: creditsApi.settings, enabled: sourcesOpen });
  const matches = useQuery({ queryKey: ["credit-search", provider, search], queryFn: () => creditsApi.search(provider, search), enabled: sourcesOpen && !!search, retry: false });
  const saved = (value: SeriesCredits) => { client.setQueryData(queryKey, value); };
  const importing = useMutation({ mutationFn: ({ provider, id }: { provider: string; id: string }) => creditsApi.import(serverId, item.id, provider, id), onSuccess: value => { saved(value); setSearch(""); } });
  const removing = useMutation({ mutationFn: ({ provider, id }: { provider: string; id: string }) => creditsApi.remove(serverId, item.id, provider, id), onSuccess: value => { saved(value); setSourceFilter("all"); } });
  const language = useMutation({ mutationFn: (value: string) => creditsApi.language(serverId, item.id, value || null), onSuccess: saved });
  const saveToken = useMutation({ mutationFn: () => creditsApi.saveToken(token.trim()), onSuccess: value => { client.setQueryData(["credit-settings"], value); setToken(""); } });
  const updatePreference = (next: CastPreference) => { setPreference(next); try { localStorage.setItem(preferenceKey, JSON.stringify(next)); } catch { /* Preference still works in memory. */ } };
  const data = query.data;
  const sources = data?.sources ?? [];
  const reportedLanguages = [...new Set(sources.map(s => s.original_language).filter((v): v is string => !!v))];
  const original = data?.original_language ?? (reportedLanguages.length === 1 ? reportedLanguages[0] : null);
  const credits = displayCredits(sourceFilter === "all" ? sources : sources.filter(s => s.provider === sourceFilter));
  const languages = [...new Set(["en", "ja", "es", "fr", "de", "it", "pt", "ko", "zh", preference.language, ...(original ? [original] : []), ...sources.flatMap(s => s.credits.map(c => c.language).filter((v): v is string => !!v))])].sort((a, b) => languageName(a).localeCompare(languageName(b)));
  const groups = castGroups(credits, original, preference);
  const crew = credits.filter(c => c.category === "crew");
  const busy = importing.isPending || removing.isPending;
  const linkedId = item.external_ids[provider] ?? (provider === "mal" ? item.external_ids.myanimelist : undefined);
  const error = importing.error ?? removing.error ?? language.error;

  return <section className="mt-10 rounded-2xl border border-white/10 bg-black/20 p-4 sm:p-5" aria-label="Cast and crew">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="flex items-center gap-2 text-lg font-semibold"><UsersRound className="size-5 text-white/60" />Cast & crew</h2>
      <button className={control} aria-expanded={sourcesOpen} onClick={() => setSourcesOpen(!sourcesOpen)}>Sources & matching</button>
    </div>
    <p className="mt-1 text-xs text-white/50">Original performances, dubbed casts, and the people behind this series.</p>
    {query.isLoading && <p className="mt-5 text-sm text-white/60" role="status">Loading saved credits…</p>}
    {query.error && <p className="mt-4 text-sm text-red-300" role="alert">Could not load credits: {query.error.message} <button onClick={() => query.refetch()}>Retry</button></p>}
    {error && <p className="mt-4 text-sm text-red-300" role="alert">{error.message}</p>}
    {sourcesOpen && <div className="mt-5 space-y-4 rounded-xl border border-white/10 bg-black/25 p-4">
      <p className="text-sm text-white/65">Match the exact series or season entry before importing. You can add multiple seasons from the same provider. Each source stays available separately.</p>
      {sources.map(source => <div key={`${source.provider}:${source.external_id}`} className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 pb-3">
        <div className="min-w-0"><a className="text-sm font-medium hover:underline" href={safeUrl(source.source_url)} target="_blank" rel="noreferrer">{creditProviders[source.provider]} · {source.title} <ExternalLink className="inline size-3" /></a>
          <p className="text-xs text-white/45">{source.credits.length} credits · {source.fetched_at ? `Saved ${new Date(source.fetched_at).toLocaleString()}` : "Saved"}</p></div>
        <div className="flex gap-2"><button className={control} disabled={busy} aria-label={`Refresh ${creditProviders[source.provider]}`} onClick={() => importing.mutate({ provider: source.provider, id: source.external_id })}><RefreshCw className="size-4" /></button>
          <button className="text-xs text-white/50 hover:text-red-300 disabled:opacity-50" disabled={busy} onClick={() => removing.mutate({ provider: source.provider, id: source.external_id })}>Remove {creditProviders[source.provider]}</button></div>
      </div>)}
      <form className="flex flex-wrap gap-2" onSubmit={e => { e.preventDefault(); if (term.trim()) setSearch(term.trim()); }}>
        <select aria-label="Credits provider" className={control} value={provider} disabled={busy} onChange={e => { setProvider(e.target.value); setSearch(""); importing.reset(); }}>{Object.entries(creditProviders).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select>
        <input aria-label="Series search" maxLength={200} className={`${control} min-w-0 flex-1`} value={term} onChange={e => setTerm(e.target.value)} />
        <button type="submit" className={control} disabled={busy || matches.isFetching || !term.trim()}><Search className="mr-1 inline size-4" />Search</button>
      </form>
      {linkedId && !sources.some(s => s.provider === provider) && <button className="text-xs text-white/65 hover:text-white" disabled={busy} onClick={() => importing.mutate({ provider, id: linkedId })}>Import using this series’ linked {creditProviders[provider]} ID ({linkedId})</button>}
      {matches.isFetching && <p className="text-sm text-white/60" role="status">Searching {creditProviders[provider]}…</p>}
      {matches.error && <p role="alert" className="text-sm text-red-300">{matches.error.message}</p>}
      {search && matches.data?.length === 0 && <p className="text-sm text-white/60">No matching series. Try an alternate title.</p>}
      {search && matches.data && <div className="max-h-72 space-y-2 overflow-y-auto">{matches.data.map(match => <div key={match.id} className="flex items-center gap-3 rounded-lg bg-white/5 p-2">
        {safeUrl(match.image) && <img src={match.image!} alt="" referrerPolicy="no-referrer" className="h-14 w-10 rounded object-cover" />}
        <div className="min-w-0 flex-1"><p className="text-sm font-medium">{match.title}</p><p className="text-xs text-white/50">{match.year ?? "Year unknown"} · ID {match.id}</p></div>
        <button className={control} disabled={busy} onClick={() => importing.mutate({ provider, id: match.id })}>Import</button>
      </div>)}</div>}
      {importing.isPending && <p role="status" className="text-sm text-white/65"><Loader2 className="mr-2 inline size-4 animate-spin" />Fetching all available cast languages and crew…</p>}
      <details className="text-xs text-white/60"><summary className="cursor-pointer">Provider connections & attribution</summary>
        <p className="mt-3">AniList needs no key. MyAnimeList credits are supplied by the unofficial Jikan API. TheTVDB uses your existing provider settings.</p>
        <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={e => { e.preventDefault(); saveToken.mutate(); }}><label className="min-w-0 flex-1">TMDb API Read Access Token {settings.data?.tmdb_configured ? "· configured" : ""}<input type="password" autoComplete="off" aria-label="TMDb API Read Access Token" className={`${control} mt-1 w-full`} value={token} onChange={e => { setToken(e.target.value); saveToken.reset(); }} placeholder="Paste token to add or replace" /></label><button className={control} disabled={!token.trim() || saveToken.isPending}>Save token</button></form>
        {saveToken.error && <p role="alert" className="mt-2 text-red-300">{saveToken.error.message}</p>}
        {saveToken.isSuccess && <p role="status" className="mt-2">TMDb token saved.</p>}
        <p className="mt-3">This product uses the TMDB API but is not endorsed or certified by TMDB. <a className="underline" href="https://www.themoviedb.org/settings/api" target="_blank" rel="noreferrer">Get a TMDb token</a>.</p>
      </details>
    </div>}
    {!query.isLoading && !query.error && !sources.length && <div className="py-8 text-center"><p className="text-sm text-white/65">No cast or crew saved for this series yet.</p><button className={`${control} mt-3`} onClick={() => setSourcesOpen(true)}>Find cast & crew</button></div>}
    {sources.length > 0 && <>
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1 rounded-lg bg-black/30 p-1" role="group" aria-label="Credit category">{(["cast", "crew"] as const).map(value => <button key={value} aria-pressed={tab === value} className={`rounded-md px-4 py-2 text-sm ${tab === value ? "bg-white/15 text-white" : "text-white/50"}`} onClick={() => setTab(value)}>{value === "cast" ? "Cast" : "Crew"} · {credits.filter(c => c.category === value).length}</button>)}</div>
        <select className={control} aria-label="Displayed credits source" value={sourceFilter} onChange={e => setSourceFilter(e.target.value)}><option value="all">All saved sources</option>{[...new Set(sources.map(s => s.provider))].map(provider => <option key={provider} value={provider}>{creditProviders[provider]}</option>)}</select>
      </div>
      {tab === "cast" ? <>
        <div className="mt-4 flex flex-wrap gap-3">
          <label className="text-xs text-white/55">Show<select className={`${control} mt-1 block`} aria-label="Cast display" value={preference.mode} onChange={e => updatePreference({ ...preference, mode: e.target.value as CastPreference["mode"] })}><option value="both">Original + selected language</option><option value="original">Original only</option><option value="dub">Selected language only</option><option value="all">All languages</option></select></label>
          {(preference.mode === "both" || preference.mode === "dub") && <label className="text-xs text-white/55">Preferred dub<select className={`${control} mt-1 block`} aria-label="Preferred dub language" value={preference.language} onChange={e => updatePreference({ ...preference, language: e.target.value })}>{languages.map(lang => <option key={lang} value={lang}>{languageName(lang)}</option>)}</select></label>}
          <label className="text-xs text-white/55">Series’ original language<select className={`${control} mt-1 block`} aria-label="Original cast language" disabled={language.isPending} value={original ?? ""} onChange={e => language.mutate(e.target.value)}><option value="">{sources.some(s => s.original_language) ? "Use provider language" : "Choose language"}</option>{languages.map(lang => <option key={lang} value={lang}>{languageName(lang)}</option>)}</select></label>
        </div>
        <p className="mt-2 text-[11px] text-white/40">Your display preference is remembered in this browser. Changing it keeps every saved cast language.</p>
        {!original && <p className="mt-3 text-sm text-amber-200">Choose the series’ original language to identify its primary cast. {reportedLanguages.length > 1 ? "The saved providers report different original languages." : "Providers do not always supply it."}</p>}
        {groups.map(group => <div className="mt-5" key={`${group.label}-${sourceFilter}`}><h3 className="mb-3 text-sm font-semibold text-white/80">{group.label} <span className="font-normal text-white/40">{group.credits.length}</span></h3>{group.credits.length ? <CreditGrid credits={group.credits} /> : <p className="rounded-lg border border-dashed border-white/15 p-4 text-sm text-white/45">{!original && group.label === "Original cast" ? "Select the original language above." : "No credits for this language in the saved sources. Try another provider to fill the gap."}</p>}</div>)}
        {groups.some(g => g.label.includes("unspecified")) && <p className="mt-3 text-xs text-white/40">These credits have no confirmed performance language. Localized provider text does not establish a dubbed cast.</p>}
      </> : <div className="mt-5">{crew.length ? <CreditGrid key={sourceFilter} credits={crew} /> : <p className="py-5 text-sm text-white/50">No crew credits supplied by these sources.</p>}</div>}
    </>}
  </section>;
}
