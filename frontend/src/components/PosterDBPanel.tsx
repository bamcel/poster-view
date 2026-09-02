// The ThePosterDB side module shown on the item detail page.
//
// Navigation is a stack so you can drill in and back out, all in-app:
//   search (Movies/Shows/Collections)
//     -> pick a title  ->  that title's posters/sets   (a "title" grid)
//        -> open a poster -> that poster's full set      (a "set" grid: seasons etc.)
//           -> apply one / Auto-apply set, or Back
// Pasting a /poster or /set URL jumps straight to a set grid.
//
// Thumbnails are proxied through our backend (/api/posterdb/image), so they load
// without a TPDb session in the browser.

import { useEffect, useState, type FormEvent } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Search,
  ExternalLink,
  ImageDown,
  Wand2,
  Loader2,
  AlertCircle,
  ArrowLeft,
  Layers,
} from "lucide-react";
import { api } from "../api/client";
import { useToast } from "../lib/toast";
import CustomTargetButton from "./CustomTargetButton";
import type {
  ImageTarget,
  ItemDetail,
  PosterAsset,
  PosterSearchResults,
  PosterSet,
} from "../types";

const TPDB = "https://theposterdb.com";
const looksLikeRef = (s: string) => /^\d+$/.test(s.trim()) || /https?:\/\//.test(s);
const isTitleUrl = (u: string) => /\/posters\/\d+/.test(u);

// Where the site icon links to: the pasted URL as-is, a bare id's poster
// page, a search results page for a free-text term, or just the homepage.
function externalTpdbUrl(query: string): string {
  const q = query.trim();
  if (!q) return TPDB;
  if (/^https?:\/\//.test(q)) return q;
  if (/^\d+$/.test(q)) return `${TPDB}/poster/${q}`;
  return `${TPDB}/search?term=${encodeURIComponent(q)}`;
}

interface Props {
  serverId: number;
  item: ItemDetail;
  /** When `nonce` changes, the panel runs a search for `term` (the hero button). */
  prefill?: { term: string; nonce: number };
}

/** One level of the drill-down stack. `isTitle` grids list covers/sets that can
 *  be opened further; non-title grids are a concrete set (apply or go back). */
type GridView = { set: PosterSet; isTitle: boolean; label?: string };

export default function PosterDBBody({ serverId, item, prefill }: Props) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<PosterSearchResults | null>(null);
  const [activeCat, setActiveCat] = useState<string | null>(null);
  const [stack, setStack] = useState<GridView[]>([]);
  const [busyLoad, setBusyLoad] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const statusQ = useQuery({ queryKey: ["posterdb-status"], queryFn: api.posterdbStatus });
  const current = stack.length ? stack[stack.length - 1] : null;
  const hasParent = stack.length > 1 || (stack.length === 1 && !!search);

  async function runSearch(term: string) {
    setBusyLoad(true);
    try {
      const fullSearch = api.posterdbSearch(term).then(
        (result) => ({ result, error: null }),
        (error: unknown) => ({ result: null, error }),
      );
      const preview = await api.posterdbSearchPreview(term).catch(() => null);
      if (preview) {
        setSearch(preview);
        setStack([]);
        const first = preview.categories.find((c) => c.results.length) ?? preview.categories[0];
        setActiveCat(first?.name ?? null);
      }

      const { result, error } = await fullSearch;
      if (error) throw error;
      if (!result) return;
      setSearch(result);
      setStack([]);
      setActiveCat((currentCategory) => {
        if (result.categories.some((category) => category.name === currentCategory)) {
          return currentCategory;
        }
        const first = result.categories.find((category) => category.results.length) ?? result.categories[0];
        return first?.name ?? null;
      });
    } catch (e) {
      toast.push("error", (e as Error).message);
    } finally {
      setBusyLoad(false);
    }
  }

  async function openGrid(url: string, opts: { replace?: boolean; label?: string } = {}) {
    setBusyLoad(true);
    try {
      const set = await api.posterdbSet(url);
      const view: GridView = { set, isTitle: isTitleUrl(url), label: opts.label };
      setStack((prev) => (opts.replace ? [view] : [...prev, view]));
    } catch (e) {
      toast.push("error", (e as Error).message);
    } finally {
      setBusyLoad(false);
    }
  }

  const goBack = () => setStack((prev) => prev.slice(0, -1));

  // Run a search when the parent requests one (and creds are configured).
  useEffect(() => {
    if (!prefill?.nonce || !prefill.term) return;
    if (statusQ.data && !statusQ.data.configured) return;
    setQuery(prefill.term);
    runSearch(prefill.term);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill?.nonce]);

  const seasonByNumber = (n?: number | null) =>
    n == null ? undefined : item.seasons.find((s) => s.index === n);

  async function refreshArtwork() {
    await queryClient.invalidateQueries({ queryKey: ["item-detail", serverId, item.id] });
    await queryClient.invalidateQueries({ queryKey: ["items", serverId] });
  }

  async function apply(
    asset: PosterAsset,
    target: ImageTarget,
    targetItemId: string,
    key: string,
    titleOverride?: string,
  ) {
    setBusyKey(key);
    try {
      const res = await api.applyPoster({
        server_id: serverId,
        item_id: targetItemId,
        target,
        download_url: asset.download_url,
        item_title: titleOverride ?? item.title,
      });
      toast.push(res.ok ? "success" : "error", res.message);
      if (res.ok) await refreshArtwork();
    } catch (e) {
      toast.push("error", (e as Error).message);
    } finally {
      setBusyKey(null);
    }
  }

  async function autoApply(posters: PosterAsset[]) {
    setBusyKey("auto");
    let applied = 0;
    try {
      const main = posters.find((p) => p.kind === "show" || p.kind === "movie");
      if (main) {
        const r = await api.applyPoster({
          server_id: serverId,
          item_id: item.id,
          target: "poster",
          download_url: main.download_url,
          item_title: item.title,
        });
        if (r.ok) applied++;
      }
      for (const p of posters) {
        if (p.kind === "season") {
          const season = seasonByNumber(p.season_number);
          if (!season) continue;
          const r = await api.applyPoster({
            server_id: serverId,
            item_id: season.id,
            target: "poster",
            download_url: p.download_url,
            item_title: `${item.title} — ${season.title}`,
          });
          if (r.ok) applied++;
        } else if (p.kind === "background") {
          const r = await api.applyPoster({
            server_id: serverId,
            item_id: item.id,
            target: "background",
            download_url: p.download_url,
            item_title: item.title,
          });
          if (r.ok) applied++;
        }
      }
      toast.push(applied ? "success" : "info", `Auto-applied ${applied} image${applied === 1 ? "" : "s"}.`);
      if (applied) await refreshArtwork();
    } finally {
      setBusyKey(null);
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    if (looksLikeRef(q)) openGrid(q, { replace: true });
    else runSearch(q);
  };

  // -- credential gate --
  if (statusQ.data && !statusQ.data.configured) {
    return (
      <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
        <AlertCircle className="size-8 text-amber-400" />
        <p className="text-sm text-muted">
          Add your ThePosterDB email & password in <span className="text-white">Settings</span> to
          search and apply posters.
        </p>
      </div>
    );
  }

  return (
    <>
      <form onSubmit={submit} className="relative mb-3">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search a title, or paste a poster/set URL…"
          className="w-full rounded-lg border border-border bg-surface-2 py-2 pl-9 pr-9 text-sm outline-none focus:border-accent"
        />
        <a
          href={externalTpdbUrl(query)}
          target="_blank"
          rel="noreferrer"
          title={query.trim() ? "Open on ThePosterDB" : "Search ThePosterDB"}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-faint transition-colors hover:text-white"
        >
          <ExternalLink className="size-4" />
        </a>
      </form>

      {busyLoad && (
        <div className="flex items-center gap-2 py-6 text-sm text-faint">
          <Loader2 className="size-4 animate-spin" /> Loading from ThePosterDB…
        </div>
      )}

      {/* A grid (a title's posters, or a concrete set) */}
      {!busyLoad && current && (
        <PosterGrid
          view={current}
          item={item}
          busyKey={busyKey}
          onBack={hasParent ? goBack : undefined}
          onAuto={() => autoApply(current.set.posters)}
          onApply={apply}
          onOpenSet={(asset) =>
            openGrid(asset.set_url ?? `${TPDB}/poster/${asset.id}`, { label: asset.title })
          }
          seasonByNumber={seasonByNumber}
        />
      )}

      {/* Categorized search results: pick a title to drill in */}
      {!busyLoad && !current && search && (
        <SearchResults
          search={search}
          activeCat={activeCat}
          setActiveCat={setActiveCat}
          onPick={(r) => openGrid(r.url, { label: r.title })}
        />
      )}

      {!busyLoad && !current && !search && (
        <div className="flex flex-col items-center gap-2 py-10 text-center text-faint">
          <ImageDown className="size-8" />
          <p className="text-sm">Search ThePosterDB or paste a poster/set link to begin.</p>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Search results: category tabs + title list
// ---------------------------------------------------------------------------

function SearchResults({
  search,
  activeCat,
  setActiveCat,
  onPick,
}: {
  search: PosterSearchResults;
  activeCat: string | null;
  setActiveCat: (c: string) => void;
  onPick: (r: { title: string; url: string }) => void;
}) {
  const cats = search.categories.filter((c) => c.count > 0 || c.results.length > 0);
  const active = cats.find((c) => c.name === activeCat) ?? cats[0];

  // Search results come from TMDB and include titles nobody uploaded posters for.
  // PosterDB search includes matching titles that have no uploaded artwork.
  // Verify every returned category in the background so each badge represents
  // the usable titles the user can actually open, not the raw provider total.
  const verifies = useQueries({
    queries: cats.map((c) => {
      const ids = c.results.map((r) => r.media_id);
      return {
        queryKey: ["posterdb-verify", ids],
        queryFn: () => api.posterdbVerify(ids),
        enabled: ids.length > 0,
        staleTime: 5 * 60_000,
      };
    }),
  });
  const verifyByName = new Map(cats.map((c, i) => [c.name, verifies[i]]));

  const availableCount = (category: (typeof cats)[number]) => {
    const verification = verifyByName.get(category.name);
    if (!verification?.data) return null;
    return category.results.filter((result) => (verification.data?.[result.media_id] ?? -1) !== 0)
      .length;
  };

  if (cats.length === 0) {
    return <p className="py-6 text-sm text-faint">No movies, shows, or collections matched.</p>;
  }

  const activeVerify = active ? verifyByName.get(active.name) : undefined;
  const activeCounts = activeVerify?.data;
  const shown = (active?.results ?? []).filter(
    (r) => !activeCounts || (activeCounts[r.media_id] ?? -1) !== 0,
  );

  return (
    <div>
      <div className="mb-3 flex gap-1">
        {cats.map((c) => {
          const count = availableCount(c);
          return (
            <button
              key={c.name}
              onClick={() => setActiveCat(c.name)}
              className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                active?.name === c.name ? "bg-accent text-black" : "bg-surface-2 text-muted hover:text-white"
              }`}
            >
              {c.name}
              <span
                className={`flex min-w-4 items-center justify-center rounded-full px-1.5 text-[10px] ${
                  active?.name === c.name ? "bg-black/20" : "bg-black/30 text-faint"
                }`}
              >
                {count ?? "…"}
              </span>
            </button>
          );
        })}
      </div>

      {active && active.results.length === 0 ? (
        <p className="py-4 text-sm text-faint">No {active.name.toLowerCase()} on this page.</p>
      ) : shown.length === 0 ? (
        <p className="py-4 text-sm text-faint">No {active?.name.toLowerCase()} with posters.</p>
      ) : (
        <>
          {activeVerify?.isLoading && (
            <div className="mb-2 flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-2 text-xs text-faint">
              <Loader2 className="size-3.5 animate-spin" /> Checking poster availability in the background…
            </div>
          )}
          <ul className="space-y-1">
            {shown.map((r) => {
              const n = activeCounts?.[r.media_id];
              return (
                <li key={r.url} className="flex items-center gap-1">
                <button
                  onClick={() => onPick(r)}
                  className="flex min-w-0 flex-1 items-center justify-between gap-2 rounded-lg border border-transparent px-3 py-2 text-left text-sm hover:border-border hover:bg-surface-2"
                  title="Show this title's posters here"
                >
                  <span className="min-w-0 truncate">{r.title}</span>
                  {n != null && n > 0 && (
                    <span className="shrink-0 rounded-full bg-black/30 px-1.5 text-[10px] text-faint">
                      {n}
                    </span>
                  )}
                </button>
                <a
                  href={r.url}
                  target="_blank"
                  rel="noreferrer"
                  className="shrink-0 rounded p-1.5 text-faint hover:text-white"
                  title="Open on ThePosterDB"
                >
                  <ExternalLink className="size-3.5" />
                </a>
                </li>
              );
            })}
          </ul>
        </>
      )}

      <p className="mt-4 rounded-lg bg-surface-2 px-3 py-2 text-xs text-faint">
        Category badges show titles with available artwork. Empty titles are hidden after checking.
        Pick one to view its posters, open a poster for its full set, then apply or go back.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Poster grid: a title's posters (drill into a set) or a concrete set (apply)
// ---------------------------------------------------------------------------

function PosterGrid({
  view,
  item,
  busyKey,
  onBack,
  onAuto,
  onApply,
  onOpenSet,
  seasonByNumber,
}: {
  view: GridView;
  item: ItemDetail;
  busyKey: string | null;
  onBack?: () => void;
  onAuto: () => void;
  onApply: (a: PosterAsset, t: ImageTarget, id: string, key: string, titleOverride?: string) => void;
  onOpenSet: (a: PosterAsset) => void;
  seasonByNumber: (n?: number | null) => ItemDetail["seasons"][number] | undefined;
}) {
  const { set, isTitle, label } = view;
  const heading = label ?? set.title ?? (isTitle ? "Posters" : "Set");

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        {onBack ? (
          <button onClick={onBack} className="flex min-w-0 items-center gap-1 text-xs text-muted hover:text-white">
            <ArrowLeft className="size-3.5 shrink-0" /> <span className="truncate">Back</span>
          </button>
        ) : (
          <span className="min-w-0 truncate text-sm font-medium" title={heading}>
            {heading}
          </span>
        )}
        <a
          href={set.set_url}
          target="_blank"
          rel="noreferrer"
          className="flex shrink-0 items-center gap-1 text-xs text-muted hover:text-white"
        >
          TPDb <ExternalLink className="size-3" />
        </a>
      </div>

      {onBack && (
        <p className="mb-3 truncate text-sm font-medium" title={heading}>
          {heading}
        </p>
      )}

      {set.posters.length === 0 ? (
        <p className="py-6 text-sm text-faint">
          No posters found here. Try another title, or paste a specific poster/set URL.
        </p>
      ) : (
        <>
          {!isTitle && (
            <button
              onClick={onAuto}
              disabled={busyKey === "auto"}
              className="mb-4 flex w-full items-center justify-center gap-2 rounded-lg bg-accent py-2 text-sm font-semibold text-black transition-colors hover:bg-accent-hover disabled:opacity-60"
            >
              {busyKey === "auto" ? <Loader2 className="size-4 animate-spin" /> : <Wand2 className="size-4" />}
              Auto-apply set
            </button>
          )}

          <div className="grid grid-cols-2 gap-3">
            {set.posters.map((asset) => {
              const season = seasonByNumber(asset.season_number);
              return (
                <div key={asset.id} className="rounded-lg border border-border bg-surface-2 p-2">
                  {isTitle ? (
                    <button
                      onClick={() => onOpenSet(asset)}
                      className="group/th relative block w-full overflow-hidden rounded"
                      title="Open this set to see all its posters"
                    >
                      <Thumb
                        src={asset.thumb_url}
                        alt={asset.title}
                        className="aspect-[2/3] w-full bg-base object-cover"
                      />
                      <span className="absolute inset-0 hidden items-center justify-center gap-1 bg-black/55 text-xs font-semibold text-white group-hover/th:flex">
                        <Layers className="size-3.5" /> View set
                        {asset.set_size != null && ` (${asset.set_size})`}
                      </span>
                    </button>
                  ) : (
                    <Thumb
                      src={asset.thumb_url}
                      alt={asset.title}
                      className="aspect-[2/3] w-full rounded bg-base object-cover"
                    />
                  )}

                  <p className="mt-1.5 truncate text-xs text-muted" title={asset.title}>
                    {asset.title}
                  </p>
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {/* Portrait posters only apply as posters; only background-
                        type images offer "Background" (right aspect ratio). */}
                    {asset.kind === "background" ? (
                      <ApplyButton
                        label="Background"
                        busy={busyKey === `b-${asset.id}`}
                        onClick={() => onApply(asset, "background", item.id, `b-${asset.id}`)}
                      />
                    ) : asset.kind === "season" && season ? (
                      <ApplyButton
                        label={`→ Season ${asset.season_number}`}
                        busy={busyKey === `s-${asset.id}`}
                        onClick={() => onApply(asset, "poster", season.id, `s-${asset.id}`, `${item.title} — ${season.title}`)}
                      />
                    ) : (
                      <ApplyButton
                        label="Poster"
                        busy={busyKey === `p-${asset.id}`}
                        onClick={() => onApply(asset, "poster", item.id, `p-${asset.id}`)}
                      />
                    )}
                    <CustomTargetButton
                      item={item}
                      busy={busyKey?.includes(asset.id) ?? false}
                      onPick={(target, targetId, label) =>
                        onApply(asset, target, targetId, `c-${asset.id}-${targetId}-${target}-${label}`, `${item.title} — ${label}`)
                      }
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

/** Thumbnail that retries a couple of times on a transient proxy hiccup. */
function Thumb({ src, alt, className }: { src: string; alt: string; className: string }) {
  const [n, setN] = useState(0);
  return (
    <img
      src={n ? `${src}&retry=${n}` : src}
      alt={alt}
      loading="lazy"
      className={className}
      onError={() => {
        if (n < 2) setTimeout(() => setN((v) => v + 1), 400 * (n + 1));
      }}
    />
  );
}

function ApplyButton({
  label,
  onClick,
  busy,
  subtle,
}: {
  label: string;
  onClick: () => void;
  busy?: boolean;
  subtle?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className={`flex items-center gap-1 rounded px-2 py-1 text-xs font-medium transition-colors disabled:opacity-60 ${
        subtle ? "bg-elevated text-muted hover:text-white" : "bg-accent/15 text-accent hover:bg-accent/25"
      }`}
    >
      {busy && <Loader2 className="size-3 animate-spin" />}
      {label}
    </button>
  );
}
