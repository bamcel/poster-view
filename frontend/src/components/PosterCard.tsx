// A poster tile: artwork on top, title/subtitle below, optional corner badge.
// Opens on a single click (and Enter for keyboard users) when `onOpen` is set.

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Film, Tv, Library, Pencil, RefreshCw, BookOpen, Check } from "lucide-react";
import { useActionMenu } from "../lib/actionMenu";
import type { ColoredEffect } from "../lib/libraryDisplay";
import "./posterEffects.css";
import AnimatedArtwork from "./AnimatedArtwork";

interface PosterCardProps {
  animationOnHover?: boolean;
  backdropView?: boolean;
  coloredTitle?: boolean;
  selectionMode?: boolean;
  onSelect?: (range: boolean) => void;
  coloredEffect?: ColoredEffect;
  image?: string;
  title: string;
  subtitle?: string;
  titleBadge?: ReactNode;
  badge?: ReactNode;
  kind?: "movie" | "show" | "collection" | "book" | "audiobook" | "folder";
  selected?: boolean;
  onOpen?: () => void;
  openLabel?: string;
  onRefresh?: () => void;
  onEditMetadata?: () => void;
  refreshing?: boolean;
}

export default function PosterCard({
  animationOnHover = false,
  backdropView = false,
  coloredTitle = false,
  selectionMode = false,
  onSelect,
  coloredEffect = "off",
  image,
  title,
  subtitle,
  titleBadge,
  badge,
  kind = "movie",
  selected,
  onOpen,
  openLabel = "Open",
  onRefresh,
  onEditMetadata,
  refreshing,
}: PosterCardProps) {
  const [hovered,setHovered]=useState(false);
  const [focused,setFocused]=useState(false);
  const Placeholder =
    kind === "book" || kind === "audiobook"
      ? BookOpen
      : kind === "show"
        ? Tv
        : kind === "collection" || kind === "folder"
          ? Library
          : Film;
  // Many libraries have artwork records whose image files are missing on the
  // server; fall back to a clean placeholder instead of a broken-image glyph.
  const [failed, setFailed] = useState(false);
  // Keep each poster's random phase stable across hover and metadata updates.
  const [shimmerDelay] = useState(() => `${-Math.random() * 5}s`);
  const [menuOpen, setMenuOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const menuKeys = useActionMenu(menuOpen, () => setMenuOpen(false), triggerRef, menuRef);
  useEffect(() => setFailed(false), [image]);
  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close, true);
    window.addEventListener("scroll", close, true);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close, true);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);
  const content = (
    <>
      <div
        className={`relative ${backdropView ? "aspect-[3/2]" : "aspect-[2/3]"} overflow-hidden rounded-xl bg-surface-2 ring-1 transition-all duration-150 ${
          onOpen
            ? "group-hover:-translate-y-1 group-hover:ring-2 group-hover:ring-accent"
            : ""
        } ${selected ? "ring-2 ring-accent" : "ring-white/5"}`}
      >
        {image && !failed ? (
          <AnimatedArtwork
            active={!animationOnHover || hovered || focused}
            src={image}
            alt={title}
            className="h-full w-full object-cover"
            onError={() => setFailed(true)}
          />
        ) : (
          <div className="grid h-full w-full place-items-center text-faint">
            <Placeholder className="size-10" />
          </div>
        )}

        {(coloredEffect === "shimmer" || coloredEffect === "both") && image && !failed && <span aria-hidden="true" style={{ animationDelay: shimmerDelay }} className="poster-colored-shimmer pointer-events-none absolute inset-0" />}
        {(coloredEffect === "badge" || coloredEffect === "both") && <span className="poster-colored-badge pointer-events-none absolute bottom-2 right-2 overflow-hidden rounded-md px-2 py-1 text-[10px] font-bold tracking-wider shadow" aria-label="Colored edition">COLORED</span>}
        {badge != null && (
          <span className="absolute right-2 top-2 grid min-w-6 place-items-center rounded-full bg-accent px-1.5 py-0.5 text-xs font-bold text-black shadow">
            {typeof badge === "string" && ["new", "reading", "finished"].includes(badge.toLowerCase()) ? badge.toUpperCase() : badge}
          </span>
        )}

        {onOpen && (
          <div className="pointer-events-none absolute inset-0 flex items-end bg-gradient-to-t from-black/70 via-transparent to-transparent opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
            <span className="m-3 rounded-md bg-white/15 px-2 py-1 text-xs font-medium backdrop-blur">
              {openLabel}
            </span>
          </div>
        )}
      </div>

      {/* Text-shadow is a no-op over a solid background (library grid) but
          keeps these legible when a card sits over the vivid backdrop image
          on the item detail page's Seasons row. */}
      <div className="mt-2 px-0.5 [text-shadow:0_1px_6px_rgba(0,0,0,0.8)]">
        <p className={`flex items-center gap-2 text-sm font-medium ${coloredTitle ? "poster-colored-title" : "text-white/90"}`}>{titleBadge ? <span className="truncate">{title}</span> : title}{titleBadge && <span className="inline-flex shrink-0 rounded-full border border-amber-400/40 bg-amber-400/15 px-2 py-0.5 text-[10px] text-amber-200">{titleBadge}</span>}</p>
        {subtitle && <p className="truncate text-xs text-faint">{subtitle}</p>}
      </div>
    </>
  );

  return onOpen ? (
    <div className="group/selection relative" onMouseEnter={()=>setHovered(true)} onMouseLeave={() => {setMenuOpen(false);setHovered(false);}} onFocus={()=>setFocused(true)} onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget))setFocused(false);}}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup={onRefresh || onEditMetadata ? "menu" : undefined}
        aria-expanded={onRefresh || onEditMetadata ? menuOpen : undefined}
        aria-controls={menuOpen ? menuId : undefined}
        onClick={event => selectionMode && onSelect ? onSelect(event.shiftKey) : onOpen()}
        onKeyDown={(event) => {
          if ((onRefresh || onEditMetadata) && (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) {
            event.preventDefault();
            setMenuOpen(true);
          }
        }}
        onContextMenu={(event) => {
          if (!onRefresh && !onEditMetadata) return;
          event.preventDefault();
          setMenuOpen(true);
        }}
        title={onRefresh || onEditMetadata ? `${title} · right-click for options` : title}
        className="group block w-full select-none text-left"
      >
        {content}
      </button>
      {onSelect && <button type="button" aria-label={`Select ${title}`} aria-pressed={!!selected}
        onClick={event => { event.stopPropagation(); onSelect(event.shiftKey); }}
        className={`absolute left-2 top-2 z-10 grid size-11 min-h-11 min-w-11 shrink-0 place-items-center rounded-full border shadow backdrop-blur-sm transition-opacity focus-visible:opacity-100 md:size-7 md:min-h-7 md:min-w-7 ${selected ? "border-accent bg-accent text-black" : "border-white/50 bg-white/20 text-white"} ${selectionMode || selected ? "opacity-100" : "opacity-0 group-hover/selection:opacity-100 group-focus-within/selection:opacity-100 [@media(hover:none)]:opacity-100"}`}>
        {selected && <Check className="size-4" />}
      </button>}
      {menuOpen && (onRefresh || onEditMetadata) && (
        <div
          ref={menuRef} id={menuId} role="menu" aria-label={`Artwork options for ${title}`} tabIndex={-1} onKeyDown={menuKeys}
          className="absolute left-2 top-14 z-30 w-max min-w-44 rounded-lg border border-border bg-elevated p-1 shadow-2xl"
          onClick={(event) => event.stopPropagation()}
        >
          {onRefresh && <button
            type="button"
            role="menuitem" tabIndex={-1}
            onClick={() => {
              setMenuOpen(false);
              triggerRef.current?.focus();
              onRefresh();
            }}
            disabled={refreshing}
            className="flex w-full items-center gap-2 whitespace-nowrap rounded-md px-3 py-1.5 text-left text-sm text-muted hover:bg-surface-2 hover:text-white disabled:opacity-50"
          >
            <RefreshCw
              className={`size-4 shrink-0 ${refreshing ? "animate-spin" : ""}`}
            />
            Refresh artwork data
          </button>}
          {onEditMetadata && <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            onClick={() => {
              setMenuOpen(false);
              onEditMetadata();
            }}
            className="flex w-full items-center gap-2 whitespace-nowrap rounded-md px-3 py-1.5 text-left text-sm text-muted hover:bg-surface-2 hover:text-white"
          >
            <Pencil className="size-4 shrink-0" />
            Edit Metadata
          </button>}
        </div>
      )}
    </div>
  ) : (
    <div title={title} className="select-none">
      {content}
    </div>
  );
}
