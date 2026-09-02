// A poster tile: artwork on top, title/subtitle below, optional corner badge.
// Opens on a single click (and Enter for keyboard users) when `onOpen` is set.

import { useEffect, useState, type ReactNode } from "react";
import { Film, Tv, Library, RefreshCw } from "lucide-react";

interface PosterCardProps {
  image?: string;
  title: string;
  subtitle?: string;
  badge?: ReactNode;
  kind?: "movie" | "show" | "collection";
  selected?: boolean;
  onOpen?: () => void;
  onRefresh?: () => void;
  refreshing?: boolean;
}

export default function PosterCard({
  image,
  title,
  subtitle,
  badge,
  kind = "movie",
  selected,
  onOpen,
  onRefresh,
  refreshing,
}: PosterCardProps) {
  const Placeholder = kind === "show" ? Tv : kind === "collection" ? Library : Film;
  // Many libraries have artwork records whose image files are missing on the
  // server; fall back to a clean placeholder instead of a broken-image glyph.
  const [failed, setFailed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => setFailed(false), [image]);
  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menuOpen]);
  const content = (
    <>
      <div
        className={`relative aspect-[2/3] overflow-hidden rounded-xl bg-surface-2 ring-1 transition-all duration-150 ${
          onOpen ? "group-hover:-translate-y-1 group-hover:ring-2 group-hover:ring-accent" : ""
        } ${
          selected ? "ring-2 ring-accent" : "ring-white/5"
        }`}
      >
        {image && !failed ? (
          <img
            src={image}
            alt={title}
            loading="lazy"
            className="h-full w-full object-cover"
            draggable={false}
            onError={() => setFailed(true)}
          />
        ) : (
          <div className="grid h-full w-full place-items-center text-faint">
            <Placeholder className="size-10" />
          </div>
        )}

        {badge != null && (
          <span className="absolute right-2 top-2 grid min-w-6 place-items-center rounded-full bg-accent px-1.5 py-0.5 text-xs font-bold text-black shadow">
            {badge}
          </span>
        )}

        {onOpen && (
          <div className="pointer-events-none absolute inset-0 flex items-end bg-gradient-to-t from-black/70 via-transparent to-transparent opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
            <span className="m-3 rounded-md bg-white/15 px-2 py-1 text-xs font-medium backdrop-blur">Open</span>
          </div>
        )}
      </div>

      {/* Text-shadow is a no-op over a solid background (library grid) but
          keeps these legible when a card sits over the vivid backdrop image
          on the item detail page's Seasons row. */}
      <div className="mt-2 px-0.5 [text-shadow:0_1px_6px_rgba(0,0,0,0.8)]">
        <p className="truncate text-sm font-medium text-white/90">{title}</p>
        {subtitle && <p className="truncate text-xs text-faint">{subtitle}</p>}
      </div>
    </>
  );

  return onOpen ? (
    <div className="relative">
      <button
        type="button"
        onClick={onOpen}
        onContextMenu={(event) => {
          if (!onRefresh) return;
          event.preventDefault();
          setMenuOpen(true);
        }}
        title={onRefresh ? `${title} · right-click for options` : title}
        className="group block w-full select-none text-left"
      >
        {content}
      </button>
      {menuOpen && onRefresh && (
        <div
          className="absolute left-2 top-2 z-30 min-w-48 rounded-lg border border-border bg-elevated p-1 shadow-2xl"
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => {
              setMenuOpen(false);
              onRefresh();
            }}
            disabled={refreshing}
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-muted hover:bg-surface-2 hover:text-white disabled:opacity-50"
          >
            <RefreshCw className={`size-4 ${refreshing ? "animate-spin" : ""}`} />
            Refresh artwork data
          </button>
        </div>
      )}
    </div>
  ) : (
    <div title={title} className="select-none">{content}</div>
  );
}
