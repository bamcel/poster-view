import type { MediaItem } from "../types";

export function volumeInventory(items: MediaItem[], expected?: number, seriesTitle?: string) {
  const owned = new Set<number>();
  let uncertain = 0;
  for (const item of items) {
    const match = /(?:^|[\s._-])(?:volume|vol\.?|v)\s*(\d+)(?=$|[\s._\-([)\]])/i.exec(item.title);
    // Ranges, decimal numbering, and omnibus editions need an explicit override.
    if (!match || /omnibus|\d+\s*[-–]\s*\d+/i.test(item.title)) { uncertain++; continue; }
    const normalize = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    if (seriesTitle && normalize(item.title.slice(0, match.index)) !== normalize(seriesTitle)) { uncertain++; continue; }
    const volume = Number(match[1]);
    if (volume < 1 || (expected && volume > expected) || /\d+\.\d+/.test(item.title)) { uncertain++; continue; }
    owned.add(volume);
  }
  const missing = expected ? Array.from({ length: expected }, (_, i) => i + 1).filter(v => !owned.has(v)) : [];
  return { owned: [...owned].sort((a, b) => a - b), missing, uncertain };
}

export function parseOwnedVolumes(value: string): number[] | null {
  const result = new Set<number>();
  if (!value.trim()) return [];
  for (const token of value.split(",")) {
    const match = /^\s*(\d+)(?:\s*-\s*(\d+))?\s*$/.exec(token);
    if (!match) return null;
    const start = Number(match[1]), end = Number(match[2] ?? match[1]);
    if (start < 1 || end < start || end > 2000) return null;
    for (let v = start; v <= end; v++) result.add(v);
  }
  return [...result].sort((a, b) => a - b);
}
