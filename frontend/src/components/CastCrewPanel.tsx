import CreditCarousel from "./CreditCarousel";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Loader2, RefreshCw, Search, UsersRound } from "lucide-react";
import { creditsApi, type SeriesCredits } from "../api/credits";
import { castGroups, creditProviders, displayCredits, languageName } from "../lib/credits";
import { useCastPreferences } from "../lib/castPreferences";
import type { ItemDetail } from "../types";

const control = "rounded-lg border border-white/15 bg-surface px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-50";
const safeUrl = (url: string | null) => url?.startsWith("https://") ? url : undefined;

export default function CastCrewPanel({ serverId, item, editing = false }: { serverId: number; item: ItemDetail; editing?: boolean }) {
  const display = useCastPreferences();
  const preference = { mode: display.value.mode, language: display.language };
  const sourcesOpen = editing;
  const [provider, setProvider] = useState("anilist");
  const [term, setTerm] = useState(item.title);
  const [search, setSearch] = useState("");
  const [token, setToken] = useState("");
  const [tab, setTab] = useState("");
  const client = useQueryClient();
  const queryKey = ["series-credits", serverId, item.id];
  const query = useQuery({ queryKey, queryFn: () => creditsApi.get(serverId, item.id), staleTime: 60_000, enabled: display.value.show || editing });
  const settings = useQuery({ queryKey: ["credit-settings"], queryFn: creditsApi.settings, enabled: sourcesOpen });
  const matches = useQuery({ queryKey: ["credit-search", provider, search], queryFn: () => creditsApi.search(provider, search), enabled: sourcesOpen && !!search, retry: false });
  const saved = (value: SeriesCredits) => { client.setQueryData(queryKey, value); };
  const importing = useMutation({ mutationFn: ({ provider, id }: { provider: string; id: string }) => creditsApi.import(serverId, item.id, provider, id), onSuccess: value => { saved(value); setSearch(""); } });
  const removing = useMutation({ mutationFn: ({ provider, id }: { provider: string; id: string }) => creditsApi.remove(serverId, item.id, provider, id), onSuccess: saved });
  const language = useMutation({ mutationFn: (value: string) => creditsApi.language(serverId, item.id, value || null), onSuccess: saved });
  const saveToken = useMutation({ mutationFn: () => creditsApi.saveToken(token.trim()), onSuccess: value => { client.setQueryData(["credit-settings"], value); setToken(""); } });
  const data = query.data;
  const sources = data?.sources ?? [];
  const reportedLanguages = [...new Set(sources.map(s => s.original_language).filter((v): v is string => !!v))];
  const original = data?.original_language ?? (reportedLanguages.length === 1 ? reportedLanguages[0] : null);
  const credits = displayCredits(sources);
  const languages = [...new Set(["en", "ja", "es", "fr", "de", "it", "pt", "ko", "zh", preference.language, ...(original ? [original] : []), ...sources.flatMap(s => s.credits.map(c => c.language).filter((v): v is string => !!v))])].sort((a, b) => languageName(a).localeCompare(languageName(b)));
  const groups = castGroups(credits, original, preference);
  const crew = credits.filter(c => c.category === "crew");
  const tabs = groups.map(group => ({ id: group.label, label: group.label.startsWith("Original cast · ") ? `${group.label.split(" · ")[1]} Cast` : group.label === "Original cast" ? "Primary Cast" : group.label.replace(/ cast$/, " Cast"), credits: group.credits, characters: false }));
  if (!display.value.hide_crew) tabs.push({ id: "crew", label: "Crew", credits: crew, characters: false });
  tabs.push({ id: "characters", label: "Characters", credits: credits.filter(c => c.category === "cast" && c.character), characters: true });
  const selectedTab = tabs.find(value => value.id === tab) ?? tabs[0];

  const busy = importing.isPending || removing.isPending;
  const linkedId = item.external_ids[provider] ?? (provider === "mal" ? item.external_ids.myanimelist : undefined);
  const error = importing.error ?? removing.error ?? language.error;

  if (!display.value.show && !editing) return null;
  return <section className="mt-10" aria-label="Cast and crew">
    {!editing && <><h2 className="flex items-center gap-2 text-lg font-semibold"><UsersRound className="size-5 text-white/60" />Cast &amp; Crew</h2>
    <p className="mt-1 text-xs text-white/50">Original performances, dubbed casts, and the people behind this title.</p></>}
    {query.isLoading && <p className="mt-5 text-sm text-white/60" role="status">Loading saved credits…</p>}
    {query.error && <p className="mt-4 text-sm text-red-300" role="alert">Could not load credits: {query.error.message} <button onClick={() => query.refetch()}>Retry</button></p>}
    {error && <p className="mt-4 text-sm text-red-300" role="alert">{error.message}</p>}
    {sourcesOpen && <div className="mt-5 space-y-4 rounded-xl border border-white/10 bg-black/25 p-4">
          <label className="text-xs text-white/55">Title’s original language<select className={`${control} mt-1 block`} aria-label="Original cast language" disabled={language.isPending} value={original ?? ""} onChange={e => language.mutate(e.target.value)}><option value="">{sources.some(s => s.original_language) ? "Use provider language" : "Choose language"}</option>{languages.map(lang => <option key={lang} value={lang}>{languageName(lang)}</option>)}</select></label>
      <p className="text-sm text-white/65">Match the exact title or season entry before importing. You can add multiple seasons from the same provider. Each source stays available separately.</p>
      {sources.map(source => <div key={`${source.provider}:${source.external_id}`} className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 pb-3">
        <div className="min-w-0"><a className="text-sm font-medium hover:underline" href={safeUrl(source.source_url)} target="_blank" rel="noreferrer">{creditProviders[source.provider]} · {source.title} <ExternalLink className="inline size-3" /></a>
          <p className="text-xs text-white/45">{source.credits.length} credits · {source.fetched_at ? `Saved ${new Date(source.fetched_at).toLocaleString()}` : "Saved"}</p></div>
        <div className="flex gap-2"><button className={control} disabled={busy} aria-label={`Refresh ${creditProviders[source.provider]}`} onClick={() => importing.mutate({ provider: source.provider, id: source.external_id })}><RefreshCw className="size-4" /></button>
          <button className="text-xs text-white/50 hover:text-red-300 disabled:opacity-50" disabled={busy} onClick={() => removing.mutate({ provider: source.provider, id: source.external_id })}>Remove {creditProviders[source.provider]}</button></div>
      </div>)}
      {item.type !== "movie" && <form className="flex flex-wrap gap-2" onSubmit={e => { e.preventDefault(); if (term.trim()) setSearch(term.trim()); }}>
        <select aria-label="Credits provider" className={control} value={provider} disabled={busy} onChange={e => { setProvider(e.target.value); setSearch(""); importing.reset(); }}>{Object.entries(creditProviders).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select>
        <input aria-label="Series search" maxLength={200} className={`${control} min-w-0 flex-1`} value={term} onChange={e => setTerm(e.target.value)} />
        <button type="submit" className={control} disabled={busy || matches.isFetching || !term.trim()}><Search className="mr-1 inline size-4" />Search</button>
      </form>}
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
    {!editing && !query.isLoading && !query.error && !sources.length && <p className="py-8 text-center text-sm text-white/65">No saved cast or crew. Use Find Missing Metadata from the title menu.</p>}
    {!editing && sources.length > 0 && <>
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2" role="tablist" aria-label="Cast and crew categories">{tabs.map(value => <button key={value.id} role="tab" aria-selected={selectedTab.id === value.id} tabIndex={selectedTab.id === value.id ? 0 : -1} id={`credit-tab-${item.id}-${encodeURIComponent(value.id)}`} aria-controls={`credit-panel-${item.id}`} className={`rounded-full px-4 py-2 text-sm font-medium ${selectedTab.id === value.id ? "bg-accent text-base" : "bg-white/5 text-muted hover:bg-white/10"}`} onClick={() => setTab(value.id)} onKeyDown={event => {
          const index = tabs.indexOf(value);
          const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1;
          if (next >= 0) { event.preventDefault(); setTab(tabs[next].id); (event.currentTarget.parentElement?.children[next] as HTMLElement)?.focus(); }
        }}>{value.label}</button>)}</div>
      </div>
      <div role="tabpanel" id={`credit-panel-${item.id}`} aria-labelledby={`credit-tab-${item.id}-${encodeURIComponent(selectedTab.id)}`} className="mt-5">
        <CreditCarousel key={selectedTab.id} credits={selectedTab.credits} characters={selectedTab.characters} label={selectedTab.label} />
        {!original && selectedTab.id === "Original cast" && <p className="mt-3 text-sm text-muted">Choose the original language in Edit Metadata → Provider matching.</p>}
      </div>
    </>}
  </section>;
}
