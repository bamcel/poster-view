import type { MediaItem } from "../types";

export function volumeInventory(items: MediaItem[], expected?: number, seriesTitle?: string) {
  const owned = new Set<number>();
  let uncertain = 0;
  for (const item of items) {
    const normalize = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    const names = [item.title, item.file_name ?? ""].map(name => name.replace(/\.(cbz|cbr|epub|pdf)$/i, ""));
    if (names.some(name => /omnibus|\d+\s*[-–]\s*\d+/i.test(name))) { uncertain++; continue; }
    const detected: number[] = [];
    let conflict = false;
    if (item.volume?.trim()) {
      if (/^\d+$/.test(item.volume.trim())) detected.push(Number(item.volume));
      else conflict = true;
    }
    for (const name of names) {
      const match = /(?:^|[\s._-])(?:volume|vol\.?|v)\s*(\d+(?:\.\d+)?)(?=$|[\s._\-([)\]])/i.exec(name)
        ?? /\s+(\d{1,3})$/.exec(name);
      if (!match) continue;
      if (seriesTitle && normalize(name.slice(0, match.index)) !== normalize(seriesTitle)) { conflict = true; continue; }
      detected.push(Number(match[1]));
    }
    const volume = detected[0];
    if (conflict || !volume || !Number.isInteger(volume) || volume < 1 || (expected && volume > expected) || detected.some(v => v !== volume)) { uncertain++; continue; }
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
