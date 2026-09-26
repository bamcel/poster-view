import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  Bookmark,
  ChevronLeft,
  ChevronRight,
  Maximize,
  Search,
  Settings2,
  List,
  X,
  BookOpen,
  PanelsLeftBottom,
} from "lucide-react";
import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentProxy,
} from "pdfjs-dist";
import worker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { readerContent } from "../lib/readerContent";
import {
  ComicPage,
  EpubChapter,
  FlowPage,
  PdfPage,
} from "../components/ReaderPages";
import {
  defaults,
  normalizeState,
  readerRequest,
  readerUrl,
  readerPages,
  type ReaderManifest,
  type ReaderSettings,
  type ReaderState,
} from "../lib/reader";

GlobalWorkerOptions.workerSrc = worker;
const button =
  "inline-flex shrink-0 whitespace-nowrap min-h-10 min-w-10 items-center justify-center gap-2 rounded-xl px-3 text-sm text-muted hover:bg-button hover:text-white disabled:opacity-35";
const input =
  "w-full rounded-lg border border-border bg-input px-3 py-2 text-sm text-white";
type Result = { page: number; label: string };

export default function ReaderPage() {
  const { serverId, itemId, bookId } = useParams();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const returnPath = params.get("return") || "/";
  const exit = () =>
    navigate(
      returnPath.startsWith("/") && !returnPath.startsWith("//")
        ? returnPath
        : "/",
    );
  const [book, setBook] = useState<ReaderManifest>();
  const [pdf, setPdf] = useState<PDFDocumentProxy>();
  const [count, setCount] = useState(0);
  const [state, setState] = useState<ReaderState>(() =>
    normalizeState(null, 1),
  );
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saveError, setSaveError] = useState("");
  const [panel, setPanel] = useState<
    "contents" | "settings" | "search" | "layout" | null
  >(null);
  const [controls, setControls] = useState(true);
  const [size, setSize] = useState({ width: 800, height: 700 });
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [searching, setSearching] = useState(false);
  const [outline, setOutline] = useState<Result[]>([]);
  const [highlight, setHighlight] = useState("");
  const viewport = useRef<HTMLDivElement>(null);
  const shell = useRef<HTMLDivElement>(null);
  const latest = useRef({ book, state, ready });
  latest.current = { book, state, ready };
  const saveChain = useRef(Promise.resolve());
  const searchRun = useRef(0);
  const persist = useCallback(() => {
    const snapshot = latest.current;
    if (!snapshot.book || !snapshot.ready) return;
    saveChain.current = saveChain.current
      .catch(() => {})
      .then(async () => {
        await readerRequest(`/api/reader/books/${snapshot.book!.id}/state`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            revision: snapshot.book!.revision,
            data: snapshot.state,
          }),
          keepalive: true,
        });
        setSaveError("");
      })
      .catch(() =>
        setSaveError(
          "Progress could not be saved. Check your connection and retry.",
        ),
      );
  }, []);
  useEffect(() => {
    let cancelled = false;
    let document: PDFDocumentProxy | undefined;
    let task: ReturnType<typeof getDocument> | undefined;
    setReady(false);
    setBook(undefined);
    setPdf(undefined);
    setError("");
    setNotice("");
    setResults([]);
    setOutline([]);
    setHighlight("");
    setPanel(null);
    searchRun.current++;
    void (async () => {
      const manifest = await readerRequest<ReaderManifest>(
        bookId
          ? `/api/reader/books/${bookId}`
          : `/api/reader/open/${serverId}/${encodeURIComponent(itemId || "")}`,
      );
      const saved = await readerRequest<{
        revision: string;
        data: ReaderState;
      } | null>(`/api/reader/books/${manifest.id}/state`);
      let total = manifest.chapters.length;
      if (manifest.format === "pdf") {
        task = getDocument({
          url: readerUrl(manifest, "file"),
          disableAutoFetch: true,
          disableStream: true,
          enableXfa: false,
          cMapUrl: "/reader-pdf/cmaps/",
          standardFontDataUrl: "/reader-pdf/standard_fonts/",
          wasmUrl: "/reader-pdf/wasm/",
          iccUrl: "/reader-pdf/iccs/",
          maxImageSize: 32_000_000,
        });
        document = await task.promise;
        total = document.numPages;
        const items = await document.getOutline();
        const headings: Result[] = [];
        const walk = async (nodes: NonNullable<typeof items>) => {
          for (const node of nodes) {
            if (node.dest) {
              try {
                const dest =
                  typeof node.dest === "string"
                    ? await document!.getDestination(node.dest)
                    : node.dest;
                if (dest)
                  headings.push({
                    page:
                      typeof dest[0] === "number"
                        ? dest[0]
                        : await document!.getPageIndex(dest[0]),
                    label: node.title,
                  });
              } catch {
                /* Malformed outline entry does not block reading. */
              }
            }
            await walk(node.items);
          }
        };
        if (items) await walk(items);
        if (!cancelled) setOutline(headings);
      }
      if (cancelled) {
        await task?.destroy();
        return;
      }
      setBook(manifest);
      setPdf(document);
      setCount(total);
      setState(
        normalizeState(
          saved?.revision === manifest.revision ? saved.data : null,
          total,
        ),
      );
      if (saved && saved.revision !== manifest.revision)
        setNotice(
          "This file changed since your last visit. Reading position and bookmarks have been reset.",
        );
      setReady(true);
    })().catch((e) => {
      if (!cancelled) setError(e.message || "Unable to open this book.");
    });
    return () => {
      cancelled = true;
      searchRun.current++;
      void task?.destroy();
    };
  }, [bookId, serverId, itemId]);
  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(persist, 700);
    return () => clearTimeout(timer);
  }, [state, ready, persist]);
  useEffect(() => {
    const flush = () => persist();
    const visibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      flush();
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [persist]);
  useEffect(() => {
    if (!ready || !viewport.current) return;
    const observer = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setSize({ width: r.width, height: r.height });
    });
    observer.observe(viewport.current);
    return () => observer.disconnect();
  }, [ready]);
  const settings = state.settings;
  const webtoon = settings.mode === "webtoon" && book?.format !== "epub";
  const spread =
    settings.pageLayout !== "single" &&
    size.width >= 800 &&
    !webtoon &&
    book?.format !== "epub";
  const setSettings = (patch: Partial<ReaderSettings>) =>
    setState((s) => ({ ...s, settings: { ...s.settings, ...patch } }));
  const go = useCallback(
    (page: number, offset = 0) => {
      page = Math.max(0, Math.min(count - 1, page));
      page = readerPages(
        page,
        count,
        spread ? settings.pageLayout : "single",
      )[0];
      if (
        page === latest.current.state.page &&
        latest.current.book?.format === "epub"
      ) {
        const frame = viewport.current?.querySelector("iframe");
        const win = frame?.contentWindow;
        const doc = frame?.contentDocument;
        if (win && doc)
          win.scrollTo(
            0,
            offset *
              Math.max(0, doc.documentElement.scrollHeight - win.innerHeight),
          );
      }
      setState((s) => ({ ...s, page, offset }));
      if (webtoon)
        requestAnimationFrame(() => {
          const element = viewport.current?.querySelector<HTMLElement>(
            `[data-page="${page}"]`,
          );
          if (element && viewport.current)
            viewport.current.scrollTop =
              element.offsetTop + element.offsetHeight * offset;
        });
      else viewport.current?.scrollTo(0, 0);
    },
    [count, webtoon, spread, settings.pageLayout],
  );
  const turn = useCallback(
    (delta: number) => {
      const page = latest.current.state.page;
      if (latest.current.book?.format === "epub") {
        const frame = viewport.current?.querySelector("iframe");
        const win = frame?.contentWindow;
        const doc = frame?.contentDocument;
        if (win && doc) {
          const end = Math.max(
            0,
            doc.documentElement.scrollHeight - win.innerHeight,
          );
          if (
            (delta > 0 && win.scrollY < end - 5) ||
            (delta < 0 && win.scrollY > 5)
          ) {
            win.scrollBy({
              top: delta * win.innerHeight * 0.85,
              behavior: "smooth",
            });
            return;
          }
        }
        go(page + delta, delta < 0 ? 1 : 0);
        return;
      }
      const group = readerPages(
        page,
        count,
        spread ? settings.pageLayout : "single",
      );
      go(delta > 0 ? group[group.length - 1] + 1 : group[0] - 1);
    },
    [go, spread, count, settings.pageLayout],
  );
  const wheelGesture = useRef({
    at: -Infinity,
    previous: -Infinity,
    total: 0,
    sign: 0,
  });
  const wheel = useCallback(
    (event: WheelEvent) => {
      if (
        !ready ||
        panel ||
        webtoon ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey
      )
        return;
      const delta =
        Math.abs(event.deltaY) >= Math.abs(event.deltaX)
          ? event.deltaY
          : event.deltaX;
      if (!delta) return;
      event.preventDefault();
      const now = performance.now();
      const gesture = wheelGesture.current;
      // Collapse trackpad momentum / repeated wheel events into deliberate turns.
      if (now - gesture.at < 350) return;
      const sign = Math.sign(delta);
      if (gesture.sign !== sign || now - gesture.previous > 200)
        gesture.total = 0;
      gesture.previous = now;
      gesture.sign = sign;
      gesture.total +=
        Math.abs(delta) *
        (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1);
      if (gesture.total < 20) return;
      gesture.at = now;
      gesture.total = 0;
      turn(sign * (settings.direction === "rtl" ? -1 : 1));
    },
    [ready, panel, webtoon, turn, settings.direction],
  );
  useEffect(() => {
    const node = viewport.current;
    if (!node || !ready) return;
    node.addEventListener("wheel", wheel, { passive: false });
    return () => node.removeEventListener("wheel", wheel);
  }, [ready, wheel]);
  const key = useCallback(
    (event: KeyboardEvent) => {
      if (
        panel ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        (event.target instanceof Element &&
          event.target.closest("input,textarea,select,button"))
      )
        return;
      if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
        event.preventDefault();
        turn(
          (event.key === "ArrowRight" ? 1 : -1) *
            (settings.direction === "rtl" ? -1 : 1),
        );
      }
      if (event.key === "Escape") setControls(true);
      if (event.key === " ") {
        event.preventDefault();
        setControls((v) => !v);
      }
    },
    [panel, settings.direction, turn],
  );
  useEffect(() => {
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [key]);
  useEffect(() => {
    if (!ready || panel) return;
    const timeout = setTimeout(() => setControls(false), 5000);
    return () => clearTimeout(timeout);
  }, [controls, panel, ready, state.page]);
  useEffect(() => {
    if (webtoon && ready) {
      const timer = setTimeout(
        () => go(latest.current.state.page, latest.current.state.offset),
        150,
      );
      return () => clearTimeout(timer);
    }
  }, [webtoon, ready, go]);
  const flowPosition = useCallback(
    (page: number, offset: number) =>
      setState((s) =>
        s.page === page && Math.abs(s.offset - offset) < 0.005
          ? s
          : { ...s, page, offset },
      ),
    [],
  );
  const epubPosition = useCallback(
    (offset: number) =>
      setState((s) =>
        Math.abs(s.offset - offset) < 0.005 ? s : { ...s, offset },
      ),
    [],
  );
  const touch = useRef<{ x: number; y: number } | null>(null);
  async function search() {
    if (!book || !query.trim()) return;
    const run = ++searchRun.current;
    setSearching(true);
    setResults([]);
    const found: Result[] = [];
    const needle = query.toLocaleLowerCase();
    try {
      for (let i = 0; i < count && found.length < 100; i++) {
        if (run !== searchRun.current) return;
        let text = "";
        if (pdf) {
          const page = await pdf.getPage(i + 1);
          const content = await page.getTextContent();
          text = content.items
            .map((item) => ("str" in item ? item.str : ""))
            .join(" ");
          page.cleanup();
        } else {
          const response = await fetch(
            readerUrl(book, "entry", book.chapters[i].name),
          );
          if (!response.ok) throw new Error("Could not search this chapter.");
          const raw = await response.text();
          text = readerContent(raw, book.chapters[i].name).textContent || "";
        }
        const index = text.toLocaleLowerCase().indexOf(needle);
        if (index >= 0)
          found.push({
            page: i,
            label: text.slice(Math.max(0, index - 35), index + 100),
          });
        if (run === searchRun.current) setResults([...found]);
      }
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Search failed.");
    } finally {
      if (run === searchRun.current) setSearching(false);
    }
  }
  const bookmark = () =>
    setState((s) => ({
      ...s,
      bookmarks: s.bookmarks.some((b) => b.page === s.page)
        ? s.bookmarks.filter((b) => b.page !== s.page)
        : [
            ...s.bookmarks,
            {
              page: s.page,
              offset: s.offset,
              label: book?.chapters[s.page]?.title || `Page ${s.page + 1}`,
            },
          ].slice(0, 100),
    }));
  const openNeighbor = (id: string) => {
    persist();
    navigate(`/reader/${id}?${new URLSearchParams({ return: returnPath })}`);
  };
  const pageWidth = Math.max(
    120,
    (Math.min(
      (size.width - 32) / (spread ? 2 : 1),
      settings.fit === "page" && !webtoon ? (size.height - 20) * 0.68 : 1600,
    ) *
      settings.zoom) /
      100,
  );
  const pages = readerPages(
    state.page,
    count,
    spread ? settings.pageLayout : "single",
  );
  const maxHeight =
    settings.fit === "page" && !webtoon
      ? (Math.max(100, size.height - 24) * settings.zoom) / 100
      : undefined;
  const renderPage = (page: number) =>
    pdf ? (
      <PdfPage
        key={page}
        pdf={pdf}
        page={page}
        width={pageWidth}
        maxHeight={maxHeight}
      />
    ) : book ? (
      <ComicPage
        key={page}
        book={book}
        page={page}
        width={pageWidth}
        maxHeight={maxHeight}
      />
    ) : null;
  const saved = state.bookmarks.some((b) => b.page === state.page);
  return (
    <div
      ref={shell}
      className="fixed inset-0 z-[100] flex flex-col bg-base text-white"
      onMouseMove={() => setControls(true)}
    >
      <header
        className={`z-20 flex min-h-16 shrink-0 flex-wrap items-center gap-2 border-b border-border bg-surface px-3 py-2 transition-opacity ${controls || panel ? "opacity-100" : "opacity-0 hover:opacity-100 focus-within:opacity-100"}`}
      >
        <button
          className={button}
          onClick={() => {
            persist();
            exit();
          }}
          aria-label="Close reader"
        >
          <ArrowLeft className="size-5" />
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">
            {book?.title || "Reader"}
          </p>
          <p className="text-xs text-faint">
            {book?.format.toUpperCase()}{" "}
            {ready &&
              `· ${book?.format === "epub" ? "Chapter" : "Page"} ${state.page + 1} of ${count}`}
          </p>
        </div>
        <div className="flex w-full items-center overflow-x-auto sm:w-auto sm:max-w-full sm:ml-auto">
          <button
            className={button}
            onClick={() => setPanel("contents")}
            aria-label="Contents and bookmarks"
          >
            <List className="size-5" />
            <span>Contents</span>
          </button>
          {book?.format !== "cbz" && (
            <button
              className={button}
              onClick={() => setPanel("search")}
              aria-label="Search book"
            >
              <Search className="size-5" />
              <span>Search</span>
            </button>
          )}
          <button
            className={`${button} ${saved ? "text-accent" : ""}`}
            disabled={!ready}
            onClick={bookmark}
            aria-label={saved ? "Remove bookmark" : "Bookmark this page"}
            aria-pressed={saved}
          >
            <Bookmark
              className="size-5"
              fill={saved ? "currentColor" : "none"}
            />
            <span>{saved ? "Bookmarked" : "Bookmark"}</span>
          </button>
          {book?.format !== "epub" && (
            <button
              className={button}
              onClick={() => setPanel("layout")}
              aria-label="Page layout"
            >
              <PanelsLeftBottom className="size-5" />
              <span>Pages</span>
            </button>
          )}
          <button
            className={button}
            onClick={() => setPanel("settings")}
            aria-label="Reader settings"
          >
            <Settings2 className="size-5" />
            <span>Settings</span>
          </button>
          <button
            className={`${button} hidden sm:inline-flex`}
            aria-label="Toggle fullscreen"
            onClick={() => {
              void (
                document.fullscreenElement
                  ? document.exitFullscreen()
                  : shell.current?.requestFullscreen()
              )?.catch(() =>
                setNotice("Fullscreen is not available in this browser."),
              );
            }}
          >
            <Maximize className="size-5" />
            <span>Fullscreen</span>
          </button>
        </div>
      </header>
      {notice && (
        <div className="flex items-center gap-2 bg-surface-2 px-4 py-2 text-xs text-muted">
          <span className="flex-1">{notice}</span>
          <button onClick={() => setNotice("")} aria-label="Dismiss notice">
            <X className="size-4" />
          </button>
        </div>
      )}
      {saveError && (
        <div role="alert" className="bg-surface-2 p-2 text-center text-sm">
          {saveError}{" "}
          <button className="text-accent" onClick={persist}>
            Retry Save
          </button>
        </div>
      )}
      {error ? (
        <div role="alert" className="m-auto max-w-lg space-y-4 p-8 text-center">
          <BookOpen className="mx-auto size-10 text-accent" />
          <h1 className="text-xl font-semibold">Unable to open book</h1>
          <p className="text-muted">{error}</p>
          <button className={button} onClick={exit}>
            Back to Library
          </button>
        </div>
      ) : !ready ? (
        <p role="status" className="m-auto">
          Opening your book…
        </p>
      ) : (
        <>
          <div
            ref={viewport}
            className="relative min-h-0 flex-1 overflow-auto overscroll-contain"
            onClick={() => {
              if (!panel) setControls((v) => !v);
            }}
            onTouchStart={(e) => {
              touch.current = {
                x: e.touches[0].clientX,
                y: e.touches[0].clientY,
              };
            }}
            onTouchEnd={(e) => {
              if (!touch.current || webtoon || book?.format === "epub") return;
              const dx = e.changedTouches[0].clientX - touch.current.x;
              const dy = e.changedTouches[0].clientY - touch.current.y;
              touch.current = null;
              if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 2)
                turn(
                  (dx < 0 ? 1 : -1) * (settings.direction === "rtl" ? -1 : 1),
                );
            }}
          >
            {book?.format === "epub" ? (
              <EpubChapter
                book={book}
                page={state.page}
                settings={settings}
                offset={state.offset}
                onPosition={epubPosition}
                onNavigate={(p) => go(p)}
                onKey={key}
                onWheel={wheel}
                search={highlight}
              />
            ) : webtoon ? (
              Array.from({ length: count }, (_, i) => (
                <FlowPage
                  key={i}
                  index={i}
                  active={state.page}
                  onPosition={flowPosition}
                >
                  <div
                    className="flex justify-center"
                    style={{ paddingBottom: settings.gap }}
                  >
                    {renderPage(i)}
                  </div>
                </FlowPage>
              ))
            ) : (
              <div
                className="flex min-h-full items-start justify-center gap-0 p-3"
                style={{
                  flexDirection:
                    settings.direction === "rtl" ? "row-reverse" : "row",
                  minWidth:
                    settings.zoom > 100 ? `${settings.zoom}%` : undefined,
                }}
              >
                {pages.map(renderPage)}
              </div>
            )}
          </div>
          <footer
            className={`z-20 flex shrink-0 items-center justify-center gap-2 border-t border-border bg-surface px-3 py-2 transition-opacity ${controls || panel ? "opacity-100" : "opacity-0 hover:opacity-100 focus-within:opacity-100"}`}
          >
            <button
              className={button}
              disabled={pages[0] === 0 && state.offset === 0}
              onClick={() => turn(-1)}
              aria-label="Previous page"
            >
              <ChevronLeft className="size-5" />
            </button>
            <label className="sr-only" htmlFor="reader-position">
              Reading position
            </label>
            <input
              id="reader-position"
              type="range"
              min={0}
              max={Math.max(0, count - 1)}
              value={state.page}
              onChange={(e) => go(Number(e.target.value))}
              className="min-w-0 max-w-xl flex-1 accent-accent"
            />
            <span className="min-w-16 text-center text-xs text-muted">
              {Math.min(
                100,
                Math.round(
                  ((state.page + (book?.format === "epub" ? state.offset : 1)) /
                    Math.max(1, count)) *
                    100,
                ),
              )}
              %
            </span>
            <button
              className={button}
              disabled={
                pages[pages.length - 1] >= count - 1 &&
                (book?.format !== "epub" || state.offset >= 0.999)
              }
              onClick={() => turn(1)}
              aria-label="Next page"
            >
              <ChevronRight className="size-5" />
            </button>
            {pages[pages.length - 1] >= count - 1 && book?.next && (
              <button
                className={`${button} text-accent`}
                onClick={() => openNeighbor(book.next!.id)}
              >
                Next Volume
              </button>
            )}
          </footer>
        </>
      )}
      {panel && (
        <div
          className="absolute inset-0 z-30 bg-black/50"
          onClick={() => {
            setPanel(null);
            searchRun.current++;
            setSearching(false);
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-label={
              panel === "layout"
                ? "Page layout"
                : panel === "settings"
                  ? "Reader settings"
                  : panel === "search"
                    ? "Search book"
                    : "Contents and bookmarks"
            }
            className="ml-auto flex h-full w-full max-w-sm flex-col border-l border-border bg-surface shadow-2xl"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Escape") setPanel(null);
              if (e.key === "Tab") {
                const nodes = Array.from(
                  e.currentTarget.querySelectorAll<HTMLElement>(
                    "button:not(:disabled), input, select, [tabindex='0']",
                  ),
                );
                const first = nodes[0],
                  last = nodes[nodes.length - 1];
                if (e.shiftKey && document.activeElement === first) {
                  e.preventDefault();
                  last?.focus();
                } else if (!e.shiftKey && document.activeElement === last) {
                  e.preventDefault();
                  first?.focus();
                }
              }
            }}
          >
            <div className="flex items-center justify-between border-b border-border p-4">
              <h2 className="font-semibold">
                {panel === "layout"
                  ? "Page Layout"
                  : panel === "settings"
                    ? "Reading Preferences"
                    : panel === "search"
                      ? "Search Book"
                      : "Contents & Bookmarks"}
              </h2>
              <button
                autoFocus
                className={button}
                onClick={() => setPanel(null)}
                aria-label="Close panel"
              >
                <X className="size-5" />
              </button>
            </div>
            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
              {panel === "layout" && (
                <fieldset className="space-y-3">
                  <legend className="mb-3 text-sm text-muted">
                    Choose how pages are paired.
                  </legend>
                  {(
                    [
                      ["single", "One Page", "Show one page at a time."],
                      [
                        "double",
                        "Two Pages",
                        "Pair pages 1–2, 3–4, and so on.",
                      ],
                      [
                        "cover",
                        "Two Pages with First Page as Cover",
                        "Show page 1 alone, then pair 2–3, 4–5, and so on.",
                      ],
                    ] as const
                  ).map(([value, label, detail]) => (
                    <label
                      key={value}
                      className={`flex cursor-pointer items-start gap-3 rounded-xl border p-4 ${settings.pageLayout === value ? "border-accent bg-accent/10" : "border-border hover:bg-button"}`}
                    >
                      <input
                        type="radio"
                        name="page-layout"
                        aria-label={label}
                        value={value}
                        checked={settings.pageLayout === value}
                        onChange={() =>
                          setSettings({
                            pageLayout: value,
                            ...(webtoon ? { mode: "book" as const } : {}),
                          })
                        }
                        className="mt-1 accent-accent"
                      />
                      <span>
                        <span className="block text-sm font-medium">
                          {label}
                        </span>
                        <span className="mt-1 block text-xs text-muted">
                          {detail}
                        </span>
                      </span>
                    </label>
                  ))}
                  <p className="text-xs text-faint">
                    Saved for this book. Narrow screens display one page while
                    keeping your selection. Selecting a page layout exits
                    Webtoon mode; manga reading direction is preserved.
                  </p>
                </fieldset>
              )}
              {panel === "settings" && (
                <>
                  {book?.format !== "epub" && (
                    <>
                      <label className="block text-sm">
                        Reading Mode
                        <select
                          className={`${input} mt-2`}
                          value={settings.mode}
                          onChange={(e) =>
                            setSettings({
                              mode: e.target.value as ReaderSettings["mode"],
                              ...(e.target.value === "manga"
                                ? { direction: "rtl" as const }
                                : e.target.value === "comic" ||
                                    e.target.value === "book"
                                  ? { direction: "ltr" as const }
                                  : {}),
                            })
                          }
                        >
                          <option value="book">Book</option>
                          <option value="comic">Comic</option>
                          <option value="manga">Manga</option>
                          <option value="webtoon">Webtoon</option>
                        </select>
                      </label>
                      <label className="block text-sm">
                        Reading Direction
                        <select
                          className={`${input} mt-2`}
                          value={settings.direction}
                          onChange={(e) =>
                            setSettings({
                              direction: e.target.value as "rtl" | "ltr",
                            })
                          }
                        >
                          <option value="ltr">Left to Right</option>
                          <option value="rtl">Right to Left</option>
                        </select>
                      </label>
                      {!webtoon && (
                        <>
                          <button
                            className={button}
                            onClick={() => setPanel("layout")}
                          >
                            <PanelsLeftBottom className="size-5" /> Page Layout
                          </button>
                          <label className="block text-sm">
                            Page Fit
                            <select
                              className={`${input} mt-2`}
                              value={settings.fit}
                              onChange={(e) =>
                                setSettings({
                                  fit: e.target.value as "page" | "width",
                                })
                              }
                            >
                              <option value="page">Fit Page</option>
                              <option value="width">Fit Width</option>
                            </select>
                          </label>
                        </>
                      )}
                      <label className="block text-sm">
                        Zoom · {settings.zoom}%
                        <input
                          className="mt-3 w-full accent-accent"
                          type="range"
                          min={50}
                          max={200}
                          step={10}
                          value={settings.zoom}
                          onChange={(e) =>
                            setSettings({ zoom: Number(e.target.value) })
                          }
                        />
                      </label>
                      {webtoon && (
                        <label className="block text-sm">
                          Page Gap · {settings.gap}px
                          <input
                            className="mt-3 w-full accent-accent"
                            type="range"
                            min={0}
                            max={32}
                            value={settings.gap}
                            onChange={(e) =>
                              setSettings({ gap: Number(e.target.value) })
                            }
                          />
                        </label>
                      )}
                    </>
                  )}
                  {book?.format === "epub" && (
                    <>
                      <label className="block text-sm">
                        Reading Theme
                        <select
                          className={`${input} mt-2`}
                          value={settings.theme}
                          onChange={(e) =>
                            setSettings({
                              theme: e.target.value as ReaderSettings["theme"],
                            })
                          }
                        >
                          <option value="app">Dark</option>
                          <option value="light">Light</option>
                          <option value="sepia">Sepia</option>
                        </select>
                      </label>
                      <label className="block text-sm">
                        Font
                        <select
                          className={`${input} mt-2`}
                          value={settings.font}
                          onChange={(e) =>
                            setSettings({
                              font: e.target.value as ReaderSettings["font"],
                            })
                          }
                        >
                          <option value="serif">Serif</option>
                          <option value="sans-serif">Sans Serif</option>
                        </select>
                      </label>
                      <label className="block text-sm">
                        Text Size · {settings.fontSize}px
                        <input
                          type="range"
                          min={14}
                          max={36}
                          value={settings.fontSize}
                          onChange={(e) =>
                            setSettings({ fontSize: Number(e.target.value) })
                          }
                          className="mt-3 w-full accent-accent"
                        />
                      </label>
                      <label className="block text-sm">
                        Line Spacing · {settings.lineHeight}
                        <input
                          type="range"
                          min={1.2}
                          max={2.4}
                          step={0.1}
                          value={settings.lineHeight}
                          onChange={(e) =>
                            setSettings({ lineHeight: Number(e.target.value) })
                          }
                          className="mt-3 w-full accent-accent"
                        />
                      </label>
                    </>
                  )}
                  <p className="text-xs text-faint">
                    Preferences are saved for this book. Arrow keys turn pages
                    or chapters; Space toggles controls. Source files are never
                    changed.
                  </p>
                  <button
                    className={button}
                    onClick={() => setSettings(defaults)}
                  >
                    Reset Preferences
                  </button>
                </>
              )}
              {panel === "contents" && (
                <>
                  <form
                    className="flex gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const data = new FormData(e.currentTarget);
                      go(Number(data.get("page")) - 1);
                      setPanel(null);
                    }}
                  >
                    <input
                      aria-label="Go to page or chapter"
                      name="page"
                      type="number"
                      min={1}
                      max={count}
                      defaultValue={state.page + 1}
                      className={input}
                    />
                    <button className={button}>Go</button>
                  </form>
                  <h3 className="text-sm font-semibold">Bookmarks</h3>
                  {state.bookmarks.length === 0 && (
                    <p className="text-xs text-muted">
                      Use the bookmark icon to save your place.
                    </p>
                  )}
                  {state.bookmarks.map((b) => (
                    <div key={b.page} className="flex items-center gap-2">
                      <button
                        className="min-w-0 flex-1 truncate text-left text-sm text-accent"
                        onClick={() => {
                          go(b.page, b.offset);
                          setPanel(null);
                        }}
                      >
                        {b.label}
                      </button>
                      <button
                        className={button}
                        aria-label={`Remove ${b.label} bookmark`}
                        onClick={() =>
                          setState((s) => ({
                            ...s,
                            bookmarks: s.bookmarks.filter(
                              (x) => x.page !== b.page,
                            ),
                          }))
                        }
                      >
                        <X className="size-4" />
                      </button>
                    </div>
                  ))}
                  <h3 className="text-sm font-semibold">
                    {book?.format === "epub" ? "Chapters" : "Navigation"}
                  </h3>
                  {(book?.format === "epub"
                    ? book.chapters.map((c, page) => ({ page, label: c.title }))
                    : outline
                  ).map((c, i) => (
                    <button
                      key={i}
                      className="block w-full rounded-lg p-2 text-left text-sm text-muted hover:bg-button"
                      onClick={() => {
                        go(c.page);
                        setPanel(null);
                      }}
                    >
                      {c.label}
                    </button>
                  ))}
                  {book?.previous && (
                    <button
                      className="block text-sm text-accent"
                      onClick={() => openNeighbor(book.previous!.id)}
                    >
                      Previous: {book.previous.title}
                    </button>
                  )}
                  {book?.next && (
                    <button
                      className="block text-sm text-accent"
                      onClick={() => openNeighbor(book.next!.id)}
                    >
                      Next: {book.next.title}
                    </button>
                  )}
                  <p className="text-xs text-faint">
                    Volumes follow filename order within this folder.
                  </p>
                </>
              )}
              {panel === "search" && (
                <>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void search();
                    }}
                    className="flex gap-2"
                  >
                    <input
                      autoFocus
                      aria-label="Search text"
                      className={input}
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      maxLength={100}
                    />
                    <button
                      className={button}
                      disabled={searching || !query.trim()}
                    >
                      <Search className="size-4" />
                    </button>
                  </form>
                  <p className="text-xs text-muted">
                    {searching
                      ? "Searching…"
                      : `${results.length} matching pages or chapters (up to 100).`}
                    {book?.format === "pdf" &&
                      " Scanned PDFs without text cannot be searched."}
                  </p>
                  {results.map((r) => (
                    <button
                      key={r.page}
                      className="block w-full rounded-lg bg-surface-2 p-3 text-left text-sm"
                      onClick={() => {
                        go(r.page);
                        setHighlight(query);
                        setPanel(null);
                      }}
                    >
                      <span className="mb-1 block text-xs text-accent">
                        {r.page + 1}
                      </span>
                      {r.label}
                    </button>
                  ))}
                </>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
