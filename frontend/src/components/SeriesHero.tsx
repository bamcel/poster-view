import type { ReactNode } from "react";
import { ArrowLeft, Film, Tv } from "lucide-react";
import { imageUrl } from "../api/client";
import type { ItemDetail } from "../types";
import { synopsisText } from "../lib/synopsisText";
import TitleMetadata from "./TitleMetadata";

export default function SeriesHero({ item, serverId, showBackdrop, onBack, actions }: {
  item: ItemDetail; serverId: number; showBackdrop: boolean; onBack: () => void; actions: ReactNode;
}) {
  const summary = synopsisText(item.summary);
  return <section aria-label="Series overview" className="relative isolate overflow-hidden border-b border-white/5">
    {showBackdrop && item.background && <div className="absolute inset-0 -z-20"><img src={imageUrl(serverId, item.background)} alt="" className="h-full w-full object-cover" /></div>}
    <div className="absolute inset-0 -z-10 bg-gradient-to-r from-base/95 via-base/80 to-base/45" />
    <div className="absolute inset-0 -z-10 bg-gradient-to-t from-base via-transparent to-base/20" />
    <div className="mx-auto max-w-[1500px] px-5 pb-10 pt-6 sm:px-8 lg:px-12 lg:pb-14">
      <nav aria-label="Series navigation" className="mb-8 flex flex-wrap items-center justify-between gap-3">
        <button onClick={onBack} aria-label="Back" className="flex min-h-10 items-center gap-2 text-sm text-white/70 transition-colors hover:text-white"><ArrowLeft className="size-4" />Back to library</button>
        {actions}
      </nav>
      <div className="flex flex-row items-end gap-5 sm:gap-7 lg:gap-10">
        <div className="aspect-[2/3] w-24 shrink-0 overflow-hidden rounded-xl border border-white/15 shadow-2xl shadow-black/50 sm:w-44 lg:w-56">
          {item.poster ? <img src={imageUrl(serverId, item.poster)} alt={`${item.title} poster`} className="h-full w-full object-cover" /> : <div className="flex h-full items-center justify-center bg-surface-2"><Film className="size-12 text-white/15" /></div>}
        </div>
        <div className="min-w-0 max-w-3xl pb-1">
          <p className="mb-4 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-accent"><Tv className="size-4" />Series</p>
          {item.logo ? <><h1 className="sr-only">{item.title}</h1><img src={imageUrl(serverId, item.logo)} alt="" className="max-h-28 max-w-full object-contain object-left drop-shadow-lg sm:max-h-36" /></> : <h1 className="text-3xl font-bold leading-tight tracking-tight sm:text-5xl lg:text-6xl">{item.title}</h1>}
          <div className="mt-5 [&>div]:mt-0 [&>div]:justify-start"><TitleMetadata item={item} /></div>
          {summary && <p className="mt-5 hidden max-w-2xl whitespace-pre-line text-sm leading-7 text-white/70 sm:block sm:text-[1rem]">{summary}</p>}
        </div>
      </div>
      {summary && <p className="mt-5 whitespace-pre-line text-sm leading-relaxed text-white/70 sm:hidden">{summary}</p>}
    </div>
  </section>;
}
