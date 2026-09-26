export interface ReaderManifest {
  id: string;
  title: string;
  format: "pdf" | "epub" | "cbz";
  revision: string;
  chapters: { name: string; title: string }[];
  previous?: { id: string; title: string };
  next?: { id: string; title: string };
}
export interface ReaderSettings {
  mode: "book" | "comic" | "manga" | "webtoon";
  direction: "ltr" | "rtl";
  spread: boolean;
  fit: "width" | "page";
  zoom: number;
  fontSize: number;
  lineHeight: number;
  font: "serif" | "sans-serif";
  theme: "app" | "light" | "sepia";
  gap: number;
}
export interface ReaderState {
  page: number;
  offset: number;
  settings: ReaderSettings;
  bookmarks: { page: number; offset: number; label: string }[];
}
export const defaults: ReaderSettings = {
  mode: "book",
  direction: "ltr",
  spread: false,
  fit: "page",
  zoom: 100,
  fontSize: 20,
  lineHeight: 1.7,
  font: "serif",
  theme: "app",
  gap: 0,
};
export function normalizeState(
  raw: Partial<ReaderState> | null,
  count: number,
): ReaderState {
  const settings = { ...defaults, ...raw?.settings };
  if (!["book", "comic", "manga", "webtoon"].includes(settings.mode))
    settings.mode = "book";
  if (!["ltr", "rtl"].includes(settings.direction)) settings.direction = "ltr";
  if (!["app", "light", "sepia"].includes(settings.theme))
    settings.theme = "app";
  if (!["page", "width"].includes(settings.fit)) settings.fit = "page";
  if (!["serif", "sans-serif"].includes(settings.font)) settings.font = "serif";
  const clamp = (v: number, min: number, max: number) =>
    Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : min;
  settings.zoom = clamp(settings.zoom, 50, 200);
  settings.fontSize = clamp(settings.fontSize, 14, 36);
  settings.lineHeight = clamp(settings.lineHeight, 1.2, 2.4);
  settings.gap = clamp(settings.gap, 0, 32);
  return {
    page: Math.floor(clamp(raw?.page ?? 0, 0, Math.max(0, count - 1))),
    offset: clamp(raw?.offset ?? 0, 0, 1),
    settings,
    bookmarks: (Array.isArray(raw?.bookmarks) ? raw.bookmarks : [])
      .filter(
        (b) =>
          b &&
          Number.isInteger(b.page) &&
          b.page >= 0 &&
          b.page < count &&
          typeof b.label === "string",
      )
      .slice(0, 100)
      .map((b) => ({
        page: b.page,
        offset: clamp(b.offset, 0, 1),
        label: b.label.slice(0, 150),
      })),
  };
}
export async function readerRequest<T>(
  url: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    if (response.status === 401)
      window.dispatchEvent(new Event("posterview:unauthorized"));
    const error = await response.json().catch(() => ({}));
    throw new Error(
      error.detail || "The reader request failed. Please try again.",
    );
  }
  return response.json();
}
export const readerUrl = (
  book: ReaderManifest,
  resource: "file" | "entry",
  name?: string,
) =>
  `/api/reader/books/${encodeURIComponent(book.id)}/${resource}?${new URLSearchParams({ revision: book.revision, ...(name ? { name } : {}) })}`;
export function epubPath(base: string, href: string): string | null {
  if (/^[a-z][a-z\d+.-]*:|^\/\//i.test(href) || href.startsWith("/"))
    return null;
  try {
    const url = new URL(href, `https://book.invalid/${base}`);
    if (url.origin !== "https://book.invalid") return null;
    return decodeURIComponent(url.pathname.slice(1));
  } catch {
    return null;
  }
}
