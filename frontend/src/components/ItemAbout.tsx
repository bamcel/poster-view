import { ExternalLink, Info } from "lucide-react";
import type { ItemDetail } from "../types";

export function providerLinks(item: ItemDetail) {
  const ids = Object.fromEntries(Object.entries(item.external_ids).map(([key, value]) => [key.toLowerCase(), value.trim()]));
  const candidates: [string, string | undefined, string][] = [
    ["AniDB", ids.anidb, "https://anidb.net/anime/"],
    ["AniList", ids.anilist, "https://anilist.co/anime/"],
    ["IMDb", ids.imdb, "https://www.imdb.com/title/"],
    ["MyAnimeList", ids.myanimelist || ids.mal, "https://myanimelist.net/anime/"],
    ["TMDB", ids.tmdb, `https://www.themoviedb.org/${item.type === "movie" ? "movie" : "tv"}/`],
    ["TVDB", ids.tvdb, `https://www.thetvdb.com/?tab=${item.type === "movie" ? "movie" : "series"}&id=`],
  ];
  const generated = candidates.filter(([name, id]) => !!id && (name === "IMDb" ? /^tt\d+$/.test(id) : /^\d+$/.test(id)))
    .map(([label, id, base]) => ({ label, href: base + encodeURIComponent(id!) }));
  const provided = (item.external_urls ?? []).flatMap(link => {
    try {
      const url = new URL(link.url);
      return link.name.trim() && ["https:", "http:"].includes(url.protocol) && !url.username && !url.password
        ? [{ label: link.name.trim(), href: url.href }] : [];
    } catch { return []; }
  });
  const seenNames = new Set<string>();
  const seenUrls = new Set<string>();
  return [...provided, ...generated].filter(link => {
    const name = link.label.toLowerCase().replace(/^the/, "");
    if (seenNames.has(name) || seenUrls.has(link.href)) return false;
    seenNames.add(name); seenUrls.add(link.href); return true;
  });
}

export default function ItemAbout({ item }: { item: ItemDetail }) {
  const links = providerLinks(item);
  const groups = [["Genres", item.genres ?? []], ["Tags", item.tags ?? []], ["Studios", item.studios ?? []]] as const;
  return <section aria-labelledby="item-about-title" className="mt-10">
    <h2 id="item-about-title" className="mb-5 flex items-center gap-2 text-lg font-semibold"><Info className="size-4 text-muted" aria-hidden="true" />About</h2>
    <dl className="space-y-5">{groups.map(([label, values]) => <div key={label}><dt className="mb-2 text-xs font-semibold text-muted">{label}</dt><dd className="flex flex-wrap gap-2">{values.length ? values.map(value => <span key={value} className={`max-w-full break-words rounded-lg border px-2.5 py-1 text-xs leading-relaxed ${label === "Genres" ? "border-accent/20 bg-accent/10 text-accent" : "border-white/10 bg-white/5 text-white/75"}`}>{value}</span>) : <span className="text-xs text-faint">Not provided</span>}</dd></div>)}
      <div><dt className="mb-2 text-xs font-semibold text-muted">Links</dt><dd className="flex flex-wrap gap-2">{links.length ? links.map(link => <a key={link.label} href={link.href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded-lg border border-accent/20 bg-accent/5 px-2.5 py-1.5 text-xs text-accent transition-colors hover:bg-accent/15">{link.label}<ExternalLink className="size-3" aria-hidden="true" /></a>) : <span className="text-xs text-faint">No provider links available</span>}</dd></div>
    </dl>
  </section>;
}
