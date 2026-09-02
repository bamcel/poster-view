// Builds the list of places an image can be applied to for a given item:
// its poster, background, logo, each season's poster (including Season 0
// / Specials), and — for a collection — each member movie/show's poster.
// Shared by ManualUpload and the "Custom" placement picker so an image from
// any source can be pointed at any target, not just its auto-detected one.

import type { ImageTarget, ItemDetail } from "../types";

export interface ApplyTarget {
  label: string;
  itemId: string;
  target: ImageTarget;
}

export function buildApplyTargets(item: ItemDetail): ApplyTarget[] {
  const base: ApplyTarget[] = [
    { label: "Poster", itemId: item.id, target: "poster" },
    { label: "Background", itemId: item.id, target: "background" },
    { label: "Logo", itemId: item.id, target: "logo" },
  ];
  const seasons: ApplyTarget[] = item.seasons.map((s) => ({
    label: `${s.title || `Season ${s.index}`}${
      s.index === 0 && !/special/i.test(s.title) ? " (Specials)" : ""
    } — poster`,
    itemId: s.id,
    target: "poster",
  }));
  // Collection members: applying to one of these doesn't leave the collection
  // page or reset the artwork search, unlike navigating into the title itself.
  const members: ApplyTarget[] = item.members.map((m) => ({
    label: `${m.title}${m.year ? ` (${m.year})` : ""} — poster`,
    itemId: m.id,
    target: "poster",
  }));
  return [...base, ...seasons, ...members];
}
