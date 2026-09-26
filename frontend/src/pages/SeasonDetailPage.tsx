import DetailSynopsis from "../components/DetailSynopsis";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, CalendarDays, ChevronDown, Clock3, Film, Layers3, RefreshCw, Search, Star } from "lucide-react";
import { api, imageUrl } from "../api/client";
import { seasonsApi, type EpisodeDetail } from "../api/seasons";
import type { Season } from "../types";

function Artwork({ src, alt, className = "", decorative = false }: { src?: string; alt: string; className?: string; decorative?: boolean }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return src && !failed ? <img src={src} alt={decorative ? "" : alt} loading={decorative ? "eager" : "lazy"} onError={() => setFailed(true)} className={`h-full w-full object-cover ${className}`} />
    : <div aria-label={decorative ? undefined : `${alt}: no artwork`} className={`flex h-full w-full items-center justify-center bg-gradient-to-br from-elevated via-surface-2 to-base ${className}`}>{!decorative && <Film className="size-12 text-white/15" aria-hidden="true" />}</div>;
}

function airDate(value: string | null) {
  if (!value) return null;
  const date = new Date(value.slice(0, 10) + "T12:00:00Z");
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function EpisodeCard({ episode, serverId }: { episode: EpisodeDetail; serverId: number }) {
  const [expanded, setExpanded] = useState(false);
  const aired = airDate(episode.aired);
  const number = episode.index == null ? "Episode" : `Episode ${String(episode.index).padStart(2, "0")}${episode.index_end != null && episode.index_end !== episode.index ? `–${String(episode.index_end).padStart(2, "0")}` : ""}`;
  return <article className="group flex items-start gap-4 sm:gap-6">
    <div className="relative aspect-video w-32 shrink-0 overflow-hidden rounded-lg bg-base sm:w-64 lg:w-80">
      <Artwork src={imageUrl(serverId, episode.image)} alt={`${episode.title} episode still`} className="transition-transform duration-500 group-hover:scale-[1.035]" />
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent" />
      <span className="sr-only">{number}</span>
      {episode.rating != null && <span className="absolute bottom-3 right-3 flex items-center gap-1 rounded-full bg-black/40 px-2 py-1 text-xs text-white backdrop-blur"><Star className="size-3 fill-amber-300 text-amber-300" aria-hidden="true" />{episode.rating.toFixed(1)}<span className="sr-only">out of 10</span></span>}
    </div>
    <div className="min-w-0 flex-1 py-1">
      <h3 className="text-base font-semibold leading-snug text-white">{episode.index != null && `${episode.index}. `}<span>{episode.title}</span></h3>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        {aired && <span className="flex items-center gap-1.5"><CalendarDays className="size-3.5" aria-hidden="true" />{aired}</span>}
        {episode.runtime_minutes != null && <span className="flex items-center gap-1.5"><Clock3 className="size-3.5" aria-hidden="true" />{episode.runtime_minutes} min</span>}
      </div>
      <p className={`mt-3 text-sm leading-relaxed text-muted ${expanded ? "" : "line-clamp-3"}`}>{episode.summary || "No synopsis available."}</p>
      {(episode.summary || episode.directors.length > 0 || episode.writers.length > 0 || episode.cast.length > 0) && <button aria-label={`${expanded ? "Less detail" : "Episode details"} for ${episode.title}`} aria-expanded={expanded} aria-controls={`episode-${episode.id}-details`} onClick={() => setExpanded(!expanded)} className="mt-4 flex min-h-8 items-center gap-1 text-xs font-medium text-accent hover:text-accent-hover">{expanded ? "Less detail" : "Episode details"}<ChevronDown aria-hidden="true" className={`size-3.5 transition-transform ${expanded ? "rotate-180" : ""}`} /><span className="sr-only"> for {episode.title}</span></button>}
      <div id={`episode-${episode.id}-details`} hidden={!expanded}>
        {expanded && <dl className="mt-3 space-y-3 border-t border-white/10 pt-3 text-xs">{[["Directed by", episode.directors], ["Written by", episode.writers], ["Cast", episode.cast]].map(([label, names]) => (names as string[]).length > 0 && <div key={label as string}><dt className="mb-1 text-faint">{label}</dt><dd className="leading-relaxed text-white/80">{(names as string[]).join(" · ")}</dd></div>)}</dl>}
      </div>
    </div>
  </article>;
}

export default function SeasonDetailPage() {
  const { serverId: serverParam, seriesId = "", seasonId = "" } = useParams();
  const serverId = Number(serverParam);
  const [params] = useSearchParams();
  const context = new URLSearchParams(params); context.delete("edit_metadata");
  const suffix = context.size ? `?${context}` : "";
  const seriesUrl = `/server/${serverId}/item/${encodeURIComponent(seriesId)}${suffix}`;
  const enabled = Number.isFinite(serverId) && !!seriesId && !!seasonId;
  const seriesQ = useQuery({ queryKey: ["item-detail", serverId, seriesId], queryFn: () => api.getItemDetail(serverId, seriesId), enabled, retry: false });
  const seasonQ = useQuery({ queryKey: ["season", serverId, seriesId, seasonId], queryFn: () => seasonsApi.get(serverId, seriesId, seasonId), enabled, retry: false });
  const season = seasonQ.data;
  const series = seriesQ.data;
  const [search, setSearch] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => { setSearch(""); if (scroller.current) scroller.current.scrollTop = 0; }, [seasonId]);
  const episodes = season?.episodes ?? [];
  const filtered = episodes.filter(episode => `${episode.title} ${episode.index ?? ""}`.toLowerCase().includes(search.trim().toLowerCase()));
  const years = [...new Set(episodes.map(episode => episode.aired?.slice(0, 4)).filter((year): year is string => !!year && /^\d{4}$/.test(year)))].sort();
  const period = years.length ? years[0] === years.at(-1) ? years[0] : `${years[0]}–${years.at(-1)}` : null;

  return <div className="media-detail relative isolate h-full overflow-hidden bg-base text-white">
    <div className="pointer-events-none absolute inset-0 -z-20"><Artwork src={imageUrl(serverId, season?.background || series?.background)} alt="" decorative /></div>
    <div className="pointer-events-none absolute inset-0 -z-10 bg-black/75" />
    <div ref={scroller} className="h-full overflow-y-auto">
    <div className="px-4 pb-4 pt-5 sm:px-6 lg:px-10">
      <div>
        <nav className="mb-8 flex items-center justify-between gap-3" aria-label="Season navigation"><Link className="flex min-h-10 items-center gap-2 text-sm text-white/70 transition-colors hover:text-white" to={seriesUrl}><ArrowLeft className="size-4" />Back to series</Link></nav>
        {seasonQ.isPending ? <div role="status" className="flex min-h-64 items-center justify-center gap-3 text-muted"><Layers3 className="size-6 animate-pulse" />Loading season…</div> : seasonQ.isError ? <div role="alert" className="rounded-2xl border border-danger/30 bg-base/80 p-8"><h1 className="text-xl font-semibold">Unable to load this season</h1><p className="mt-2 text-muted">{seasonQ.error.message}</p><button className="mt-4 text-accent" onClick={() => void seasonQ.refetch()}>Try again</button></div> : season && <div className="flex flex-row items-start gap-5 sm:gap-8 lg:gap-9">
          <div className="aspect-[2/3] w-28 shrink-0 overflow-hidden rounded-xl shadow-2xl shadow-black/50 sm:w-[25%] sm:max-w-[328px]"><Artwork src={imageUrl(serverId, season.poster || series?.seasons.find(s => s.id === season.id)?.poster || series?.poster)} alt={`${season.title} poster`} /></div>
          <div className="min-w-0 flex-1 pt-2">
            <Link to={seriesUrl} className="text-xl font-semibold text-white hover:text-accent sm:text-3xl">{series?.logo ? <img src={imageUrl(serverId, series.logo)} alt={series.title} className="max-h-24 max-w-full object-contain object-left sm:max-w-[400px]" /> : series?.title || "Series"}</Link>

            <h1 className="mt-3 text-xl font-semibold leading-tight sm:text-2xl">{season.title}</h1>
            <div className="mt-5 flex flex-wrap items-center gap-3 text-sm text-white/75">{season.index === 0 && <span>Specials</span>}{period && <span>{period}</span>}<span className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1.5"><Layers3 className="size-3.5" />{episodes.length} {episodes.length === 1 ? "episode" : "episodes"}</span></div>
            <div className="mt-4"><button aria-label="Refresh season" title="Refresh season" disabled={seasonQ.isFetching} className="rounded-full border border-white/15 p-2.5 text-white/70 hover:bg-white/10 disabled:opacity-40" onClick={() => { void seasonQ.refetch(); void seriesQ.refetch(); }}><RefreshCw className={`size-4 ${seasonQ.isFetching ? "animate-spin" : ""}`} /></button></div>
            <div className="hidden sm:block"><DetailSynopsis key={season.id} text={season.summary || series?.summary} /></div>
          </div>
        </div>}
        {season && <div className="sm:hidden"><DetailSynopsis key={season.id} text={season.summary || series?.summary} /></div>}
      </div>
    </div>
    {season && <section aria-labelledby="season-episodes-title" className="px-4 pb-12 pt-6 sm:px-6 lg:px-10">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4"><div><h2 id="season-episodes-title" className="text-xl font-semibold">Episodes</h2><p className="mt-1 text-xs text-muted">{search ? `${filtered.length} of ${episodes.length}` : `${episodes.length} in this season`}</p></div><div className="flex flex-wrap gap-3">{(series?.seasons.length ?? 0) > 1 && <label className="sr-only" htmlFor="season-picker">Select season</label>}{(series?.seasons.length ?? 0) > 1 && <SeasonPicker seasons={series!.seasons} current={seasonId} serverId={serverId} seriesId={seriesId} suffix={suffix} />}{episodes.length > 0 && <label className="flex items-center gap-2 rounded-full border border-border bg-surface px-4 py-2.5 text-muted"><Search className="size-4" /><input aria-label="Search episodes" placeholder="Find an episode" value={search} onChange={event => setSearch(event.target.value)} className="w-40 bg-transparent text-sm text-white outline-none placeholder:text-faint" /></label>}</div></div>
      {!episodes.length ? <div className="rounded-2xl border border-dashed border-border py-16 text-center"><Film className="mx-auto mb-3 size-9 text-faint" /><h3>No episodes available</h3><p className="mt-2 text-sm text-muted">Episodes will appear here once your media server has indexed them.</p></div> : !filtered.length ? <p role="status" className="py-12 text-center text-muted">No episodes match “{search}”.</p> : <div className="space-y-5">{filtered.map(episode => <EpisodeCard key={`${season.id}:${episode.id}`} episode={episode} serverId={serverId} />)}</div>}
    </section>}
  </div></div>;
}

function SeasonPicker({ seasons, current, serverId, seriesId, suffix }: { seasons: Season[]; current: string; serverId: number; seriesId: string; suffix: string }) {
  const navigate = useNavigate();
  return <select id="season-picker" value={current} onChange={event => navigate(`/server/${serverId}/series/${encodeURIComponent(seriesId)}/season/${encodeURIComponent(event.target.value)}${suffix}`)} className="max-w-52 rounded-full border border-border bg-surface px-4 py-2 text-sm">{!seasons.some(season => season.id === current) && <option value={current}>Current season</option>}{seasons.map(season => <option key={season.id} value={season.id}>{season.title}</option>)}</select>;
}
