import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import type { DisplayCredit } from "../lib/credits";
import { creditProviders, languageName } from "../lib/credits";
import DetailSynopsis from "./DetailSynopsis";

const safeImage = (url?: string | null) => url?.startsWith("https://") ? url : undefined;

export default function CreditCarousel({ credits, characters, label, showCharacterPortraits = false }: { credits: DisplayCredit[]; characters: boolean; label: string; showCharacterPortraits?: boolean }) {
  const row = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: true });
  const [selected, setSelected] = useState<string | null>(null);
  const profiles = new Map<string, { name: string; image: string | null; bio?: string | null; credits: DisplayCredit[] }>();
  for (const credit of credits) {
    const name = credit.character?.trim();
    if (!name) continue;
    const key = name.toLocaleLowerCase();
    const profile = profiles.get(key);
    if (profile) { profile.credits.push(credit); profile.image ??= credit.character_image; profile.bio ??= credit.character_bio; }
    else profiles.set(key, { name, image: credit.character_image, bio: credit.character_bio, credits: [credit] });
  }
  const cards = characters ? [...profiles].map(([key, profile]) => ({ key, name: profile.name, image: profile.image, subtitle: "Character info" }))
    : credits.map((credit, index) => ({ key: `${credit.person_id}-${index}`, name: credit.name, image: credit.image, subtitle: credit.character || credit.role }));
  const profile = selected ? profiles.get(selected) : undefined;
  useEffect(() => {
    const element = row.current;
    if (!element) return;
    const update = () => setEdges({ start: element.scrollLeft <= 1, end: element.scrollLeft + element.clientWidth >= element.scrollWidth - 2 });
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientWidth : 1);
      const next = Math.max(0, Math.min(element.scrollWidth - element.clientWidth, element.scrollLeft + delta));
      if (next !== element.scrollLeft) { event.preventDefault(); element.scrollLeft = next; }
    };
    update();
    const resize = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(update);
    resize?.observe(element);
    element.addEventListener("scroll", update);
    element.addEventListener("wheel", wheel, { passive: false });
    return () => { resize?.disconnect(); element.removeEventListener("scroll", update); element.removeEventListener("wheel", wheel); };
  }, [credits, characters]);
  const move = (direction: number) => row.current?.scrollBy({ left: direction * row.current.clientWidth * 0.8, behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  if (!cards.length) return <p className="py-6 text-sm text-muted">No {characters ? "characters" : label.toLowerCase()} available in the saved sources.</p>;
  return <>
    <div className="relative px-5 sm:px-6">
      <div ref={row} role="region" aria-label={`${label} carousel`} tabIndex={0} className="flex gap-4 overflow-x-auto overscroll-x-contain pb-3 focus-visible:outline-accent" onKeyDown={event => { if (event.target === event.currentTarget && ["ArrowLeft", "ArrowRight"].includes(event.key)) { event.preventDefault(); move(event.key === "ArrowLeft" ? -1 : 1); } }}>
        {cards.map((card, index) => <article key={card.key} className="w-36 shrink-0 text-center sm:w-44">
          <button type="button" disabled={!characters} aria-label={characters ? `Character info for ${card.name}` : card.name} aria-expanded={characters ? selected === card.key : undefined} onClick={() => setSelected(selected === card.key ? null : card.key)} className="relative block aspect-[2/3] w-full overflow-hidden rounded-xl bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-default">
            <span className="absolute inset-0 grid place-items-center text-4xl text-muted" aria-hidden="true">{card.name[0]}</span>
            {safeImage(card.image) && <img src={card.image!} alt="" loading="lazy" referrerPolicy="no-referrer" className="relative h-full w-full object-cover" onError={event => { event.currentTarget.style.visibility = "hidden"; }} />}
            {showCharacterPortraits && !characters && credits[index].category === "cast" && credits[index].character && safeImage(credits[index].character_image) && <img
              src={credits[index].character_image!} alt={`${credits[index].character} character portrait`} title={credits[index].character!}
              loading="lazy" referrerPolicy="no-referrer"
                  className="absolute bottom-2 right-2 aspect-[2/3] w-[18%] rounded-lg border-2 border-surface bg-surface object-cover shadow-lg"
              onError={event => { event.currentTarget.style.display = "none"; }}
            />}
          </button>
          <p className="mt-2 text-sm font-semibold leading-snug">{card.name}</p>
          <p className="mt-1 text-sm leading-snug text-muted">{card.subtitle}</p>
          {!characters && <><p className="mt-1 text-xs text-muted">{credits[index].dub_group || (credits[index].character ? credits[index].role : "")}</p>
            {credits[index].notes && <p className="mt-1 text-xs text-muted">{credits[index].notes}</p>}
            <div className="mt-2 flex flex-wrap justify-center gap-2 text-xs text-muted">{credits[index].sources.map(source => <a key={source.provider} href={safeImage(source.url)} target="_blank" rel="noreferrer">{creditProviders[source.provider]}</a>)}</div></>}
        </article>)}
      </div>
      <button aria-label={`Previous ${label}`} disabled={edges.start} onClick={() => move(-1)} className="absolute left-0 top-24 grid size-10 place-items-center rounded-full border border-border bg-surface text-white shadow-lg disabled:opacity-30 sm:top-28"><ChevronLeft className="size-6" /></button>
      <button aria-label={`Next ${label}`} disabled={edges.end} onClick={() => move(1)} className="absolute right-0 top-24 grid size-10 place-items-center rounded-full border border-border bg-surface text-white shadow-lg disabled:opacity-30 sm:top-28"><ChevronRight className="size-6" /></button>
    </div>
    {profile && <section aria-label={`${profile.name} character information`} className="mt-5 rounded-xl border border-border bg-surface/90 p-5">
      <div className="flex items-center justify-between gap-3"><h3 className="text-lg font-semibold">{profile.name}</h3><button aria-label="Close character information" onClick={() => setSelected(null)} className="p-2"><X className="size-4" /></button></div>
      <div className="mt-3 text-sm">{profile.bio ? <DetailSynopsis text={profile.bio} collapsible={false} /> : <p className="mt-3 text-muted">No biography saved. Find Missing Metadata can retrieve biographies from linked AniList records.</p>}</div>
      <h4 className="mb-2 mt-4 text-sm font-semibold">Performers</h4>
      <ul className="space-y-1 text-sm text-muted">{profile.credits.map((credit, index) => <li key={index}>{credit.name} · {credit.language ? languageName(credit.language) : "Language unspecified"}{credit.dub_group ? ` · ${credit.dub_group}` : ""}</li>)}</ul>
    </section>}
  </>;
}
