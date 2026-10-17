import {LibraryPageBack} from "../lib/libraryHeaderBack";
import type {ReactNode} from "react";
import {ArrowLeft} from "lucide-react";

type HeroProps={artwork:ReactNode;children:ReactNode;synopsis?:ReactNode;landscape?:boolean};

// Shared geometry only: callers retain artwork playback, actions and type-specific metadata.
export function LibraryDetailHero({artwork,children,synopsis,landscape=false}:HeroProps){
  return <>
    <div className={landscape?"flex flex-col items-start gap-6 md:flex-row md:gap-9":"flex flex-row items-start gap-5 sm:gap-8 lg:gap-9"}>
      <div className={landscape?"w-full shrink-0 md:w-[38%] md:max-w-[520px]":"w-28 shrink-0 sm:w-[25%] sm:max-w-[328px]"}>
        <div className={`relative ${landscape?"aspect-video":"aspect-[2/3]"} overflow-hidden rounded-xl bg-surface-2 shadow-2xl shadow-black/50 ring-1 ring-white/10`}>{artwork}</div>
      </div>
      <div className="min-w-0 flex-1 pt-2 text-left [text-shadow:0_2px_12px_rgba(0,0,0,0.8)]">
        {children}
        {synopsis&&<div className={landscape?"text-left":"hidden sm:block"}>{synopsis}</div>}
      </div>
    </div>
    {!landscape&&synopsis&&<div className="sm:hidden">{synopsis}</div>}
  </>;
}

export function LibraryDetailSection({children,label,labelledBy}:{children:ReactNode;label?:string;labelledBy?:string}){
  return <section aria-label={label} aria-labelledby={labelledBy} className="mt-10 [&>h2]:mb-4 [&>h2]:text-xl [&>h2]:font-semibold">{children}</section>;
}

type LayoutProps={back:()=>void;toolbar?:ReactNode;landscape?:boolean;hero:ReactNode;related?:ReactNode;people?:ReactNode;about?:ReactNode;media?:ReactNode};

// All library details keep the same order; absent feature slots render nothing.
export default function LibraryDetailLayout({back,toolbar,landscape=false,hero,related,people,about,media}:LayoutProps){
  return <div className={`media-detail ${landscape?"episode-detail":""} scrollbar-hidden relative z-[1] h-full flex-1 overflow-y-auto overscroll-y-contain`}>
    <div className="relative min-h-full">
      <div className="absolute inset-x-5 top-5 z-10 grid min-h-11 grid-cols-[44px_minmax(0,1fr)_44px] items-center gap-3">
        <LibraryPageBack><button onClick={back} aria-label="Back" className="grid place-items-center" data-icon-button="true"><ArrowLeft className="size-5"/></button></LibraryPageBack>
        <div className="col-start-2">{toolbar}</div>
      </div>
      <div className="relative z-[1] px-4 pb-8 pt-20 sm:px-6 sm:pb-10 lg:px-10">
        {hero}
        {related}
        {people}
        {about}
        {media}
      </div>
    </div>
  </div>;
}
