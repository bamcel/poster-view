/** Explicit NFO sort titles win; otherwise ignore only the leading article "The". */
export function titleSortKey(title: string, sortTitle?: unknown): string {
  if (typeof sortTitle === "string" && sortTitle.trim()) return sortTitle.trim();
  return title.trim().replace(/^the\s+(?=\S)/i, "");
}
