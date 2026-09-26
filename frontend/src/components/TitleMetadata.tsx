import { Star } from "lucide-react";
import type { ItemDetail } from "../types";

export default function TitleMetadata({ item }: { item: ItemDetail }) {
  const seasons = item.season_count ?? item.seasons.length;
  return <div aria-label="Title information" className="mt-3 flex flex-wrap items-center justify-center gap-x-3 gap-y-2 text-sm text-white/80 sm:justify-start">
    {item.rating != null && Number.isFinite(item.rating) && <span aria-label={`Rating ${item.rating.toFixed(1)} out of 10`} className="inline-flex items-center gap-1"><Star aria-hidden="true" className="size-4 fill-accent text-accent" />{item.rating.toFixed(1)}</span>}
    {item.year != null && <span>{item.year}</span>}
    {item.studios?.[0] && <span className="text-accent">{item.studios[0]}</span>}
    {item.type === "show" && <span>{seasons} {seasons === 1 ? "Season" : "Seasons"}</span>}
    {item.content_rating?.trim() && <span className="rounded border border-white/40 px-1.5 py-0.5 text-xs font-semibold leading-tight">{item.content_rating}</span>}
    {item.genres?.[0] && <span className="text-accent">{item.genres[0]}</span>}
  </div>;
}
