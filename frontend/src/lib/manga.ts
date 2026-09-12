import type { ItemDetail } from "../types";

export function normalizeVolume(value?: string | null): string {
  const trimmed = value?.trim() ?? "";
  return /^\d+(?:\.\d+)?$/.test(trimmed)
    ? String(Number(trimmed))
    : trimmed.toLowerCase();
}

export function detectManga(
  item: Pick<ItemDetail, "title" | "file_name" | "volume">,
) {
  for (const source of [item.title, item.file_name ?? ""]) {
    const name = source.replace(/\.(epub|cbz|cbr|pdf|m4b|mp3|flac)$/i, "");
    const explicit =
      /(?:^|[\s._-])(?:volume|vol\.?|v)\s*(\d+(?:\.\d+)?)(?=$|[\s_\-([)\]])/i.exec(
        name,
      );
    const trailing = /\s+(\d{1,3}(?:\.\d+)?)$/.exec(name);
    const match = explicit ?? trailing;
    if (match)
      return {
        series:
          name.slice(0, match.index).replace(/[\s._-]+$/, "") || item.title,
        volume: normalizeVolume(item.volume ?? match[1]),
      };
  }
  return { series: item.title, volume: normalizeVolume(item.volume) };
}
