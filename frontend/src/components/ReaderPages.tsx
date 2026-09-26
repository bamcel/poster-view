import { useEffect, useRef, useState } from "react";
import { readerContent } from "../lib/readerContent";
import type { PDFDocumentProxy } from "pdfjs-dist";
import {
  epubPath,
  readerUrl,
  type ReaderManifest,
  type ReaderSettings,
} from "../lib/reader";

export function PdfPage({
  pdf,
  page,
  width,
  maxHeight,
}: {
  pdf: PDFDocumentProxy;
  page: number;
  width: number;
  maxHeight?: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    let task: { cancel: () => void } | undefined;
    void pdf
      .getPage(page + 1)
      .then(async (p) => {
        if (cancelled || !canvas.current) return;
        const viewport = p.getViewport({
          scale:
            (Math.min(2, window.devicePixelRatio || 1) * width) /
            p.getViewport({ scale: 1 }).width,
        });
        const node = canvas.current;
        node.width = Math.min(4096, viewport.width);
        node.height = Math.min(8192, viewport.height);
        const scale = Math.min(
          node.width / viewport.width,
          node.height / viewport.height,
          1,
        );
        const renderViewport = p.getViewport({ scale: viewport.scale * scale });
        node.width = renderViewport.width;
        node.height = renderViewport.height;
        task = p.render({ canvas: node, viewport: renderViewport });
        await (task as ReturnType<typeof p.render>).promise;
      })
      .catch((e) => {
        if (!cancelled && e.name !== "RenderingCancelledException")
          setError("This PDF page could not be rendered.");
      });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [pdf, page, width]);
  return error ? (
    <p role="alert">{error}</p>
  ) : (
    <canvas
      ref={canvas}
      aria-label={`Page ${page + 1}`}
      style={{
        width,
        maxWidth: "100%",
        height: "auto",
        maxHeight,
        objectFit: "contain",
      }}
      className="mx-auto shadow-lg"
    />
  );
}

export function ComicPage({
  book,
  page,
  width,
  loaded,
  maxHeight,
}: {
  book: ReaderManifest;
  page: number;
  width: number;
  loaded?: () => void;
  maxHeight?: number;
}) {
  const [error, setError] = useState(false);
  return error ? (
    <p role="alert">
      Page {page + 1} could not be loaded. Reopen the book if it changed.
    </p>
  ) : (
    <img
      src={readerUrl(book, "entry", book.chapters[page]?.name)}
      alt={`Page ${page + 1}`}
      onLoad={loaded}
      onError={() => setError(true)}
      draggable={false}
      style={{ width, maxWidth: "100%", maxHeight, objectFit: "contain" }}
      className="mx-auto h-auto"
    />
  );
}

// Lazy placeholders retain measured height; offscreen canvases/images are unmounted.
export function FlowPage({
  index,
  active,
  onPosition,
  children,
}: {
  index: number;
  active: number;
  onPosition: (page: number, offset: number) => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(Math.abs(index - active) < 2);
  const [height, setHeight] = useState(1000);
  useEffect(() => {
    const node = ref.current!;
    const observer = new IntersectionObserver(
      (entries) => setVisible(entries[0].isIntersecting),
      { root: node.parentElement, rootMargin: "1200px" },
    );
    observer.observe(node);
    const resize = new ResizeObserver(() => {
      if (node.children.length) setHeight(node.getBoundingClientRect().height);
    });
    resize.observe(node);
    const onScroll = () => {
      const parent = node.parentElement!;
      const top =
        node.getBoundingClientRect().top - parent.getBoundingClientRect().top;
      if (top <= 20 && top + node.offsetHeight > 20)
        onPosition(index, Math.max(0, Math.min(1, -top / node.offsetHeight)));
    };
    node.parentElement?.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      observer.disconnect();
      resize.disconnect();
      node.parentElement?.removeEventListener("scroll", onScroll);
    };
  }, [index, onPosition]);
  const rendered = visible || Math.abs(index - active) < 2;
  return (
    <div
      ref={ref}
      data-page={index}
      style={{ minHeight: rendered ? undefined : height }}
    >
      {rendered ? children : null}
    </div>
  );
}

export function EpubChapter({
  book,
  page,
  settings,
  offset,
  onPosition,
  onNavigate,
  onKey,
  search,
}: {
  book: ReaderManifest;
  page: number;
  settings: ReaderSettings;
  offset: number;
  onPosition: (offset: number) => void;
  onNavigate: (page: number) => void;
  onKey: (event: KeyboardEvent) => void;
  search: string;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [html, setHtml] = useState("");
  const [error, setError] = useState("");
  const position = useRef(offset);
  const callbacks = useRef({ onPosition, onNavigate, onKey });
  callbacks.current = { onPosition, onNavigate, onKey };
  useEffect(() => {
    position.current = offset;
  }, [offset]);
  useEffect(() => {
    const abort = new AbortController();
    const urls: string[] = [];
    setHtml("");
    setError("");
    void (async () => {
      const name = book.chapters[page].name;
      const response = await fetch(readerUrl(book, "entry", name), {
        signal: abort.signal,
      });
      if (!response.ok)
        throw new Error(
          "Chapter could not be loaded. Reopen the book if the file changed.",
        );
      const source = await response.text();
      const content = readerContent(source, name);
      const doc = content.ownerDocument;
      // No remote resources, publisher styles, or executable SVG content.
      const images = Array.from(content.querySelectorAll("img"));
      if (images.length > 256)
        throw new Error(
          "This chapter exceeds the 256-illustration reader limit.",
        );
      let imageBytes = 0;
      for (const img of images) {
        const path = img.getAttribute("data-reader-resource");
        img.removeAttribute("data-reader-resource");
        if (!path || !/\.(png|jpe?g|gif|webp)$/i.test(path)) {
          img.replaceWith(
            doc.createTextNode(img.alt || "[Unsupported illustration]"),
          );
          continue;
        }
        const image = await fetch(readerUrl(book, "entry", path), {
          signal: abort.signal,
        });
        if (image.ok) {
          const blob = await image.blob();
          imageBytes += blob.size;
          if (imageBytes > 64 * 1024 * 1024)
            throw new Error(
              "This chapter exceeds the 64 MB illustration limit.",
            );
          if (abort.signal.aborted) return;
          const url = URL.createObjectURL(blob);
          urls.push(url);
          img.src = url;
        }
      }
      for (const anchor of content.querySelectorAll("a")) {
        const href = anchor.getAttribute("href") || "";
        const path = epubPath(name, href);
        const chapter = book.chapters.findIndex((c) => c.name === path);
        anchor.removeAttribute("href");
        if (chapter >= 0) {
          anchor.setAttribute("data-chapter", String(chapter));
          anchor.setAttribute("href", "#");
        }
      }
      if (search.trim()) {
        const walker = doc.createTreeWalker(content, NodeFilter.SHOW_TEXT);
        const texts: Text[] = [];
        while (walker.nextNode()) texts.push(walker.currentNode as Text);
        for (const text of texts) {
          const value = text.textContent || "";
          const index = value
            .toLocaleLowerCase()
            .indexOf(search.toLocaleLowerCase());
          if (index < 0) continue;
          const fragment = doc.createDocumentFragment();
          fragment.append(value.slice(0, index));
          const mark = doc.createElement("mark");
          mark.textContent = value.slice(index, index + search.length);
          fragment.append(mark, value.slice(index + search.length));
          text.replaceWith(fragment);
        }
      }
      const app = getComputedStyle(document.documentElement);
      const foreground =
        settings.theme === "light"
          ? "#202020"
          : settings.theme === "sepia"
            ? "#403626"
            : app.getPropertyValue("--color-text").trim() || "#dedee5";
      const background =
        settings.theme === "light"
          ? "#fafafa"
          : settings.theme === "sepia"
            ? "#f1e6cf"
            : "#202329";
      const body = `<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src blob:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html{background:${background};color:${foreground};color-scheme:${settings.theme === "app" ? "dark" : "light"}}body{margin:0 auto;padding:32px 24px 60px;max-width:760px;overflow-wrap:anywhere;font-family:${settings.font};font-size:${settings.fontSize}px;line-height:${settings.lineHeight}}img{display:block;max-width:100%;height:auto;margin:1em auto}table{max-width:100%;overflow:auto;display:block}a{color:inherit;text-decoration:underline}mark{background:#e2c55c;color:#111}h1,h2,h3{line-height:1.3}</style></head><body>${content.innerHTML}</body></html>`;
      if (!abort.signal.aborted) setHtml(body);
    })().catch((e) => {
      if (!abort.signal.aborted) setError(e.message);
    });
    return () => {
      abort.abort();
      urls.forEach(URL.revokeObjectURL);
    };
  }, [
    book,
    page,
    settings.font,
    settings.fontSize,
    settings.lineHeight,
    settings.theme,
    search,
  ]);
  const detach = useRef<() => void>(() => {});
  useEffect(() => () => detach.current(), []);
  function loaded() {
    detach.current();
    const win = frame.current?.contentWindow;
    const doc = frame.current?.contentDocument;
    if (!win || !doc) return;
    const scroll = () =>
      callbacks.current.onPosition(
        win.scrollY /
          Math.max(1, doc.documentElement.scrollHeight - win.innerHeight),
      );
    const click = (event: MouseEvent) => {
      const anchor = (event.target as Element)?.closest("a");
      if (anchor) {
        event.preventDefault();
        const chapter = Number(anchor.getAttribute("data-chapter"));
        if (Number.isInteger(chapter)) callbacks.current.onNavigate(chapter);
      }
    };
    const key = (event: KeyboardEvent) => callbacks.current.onKey(event);
    win.addEventListener("scroll", scroll, { passive: true });
    doc.addEventListener("click", click);
    doc.addEventListener("keydown", key);
    win.scrollTo(
      0,
      position.current *
        Math.max(0, doc.documentElement.scrollHeight - win.innerHeight),
    );
    if (search) doc.querySelector("mark")?.scrollIntoView({ block: "center" });
    detach.current = () => {
      win.removeEventListener("scroll", scroll);
      doc.removeEventListener("click", click);
      doc.removeEventListener("keydown", key);
    };
  }
  return error ? (
    <p role="alert" className="p-8">
      {error}
    </p>
  ) : html ? (
    <iframe
      ref={frame}
      title={book.chapters[page].title}
      sandbox="allow-same-origin"
      srcDoc={html}
      onLoad={loaded}
      className="h-full w-full border-0"
    />
  ) : (
    <p role="status" className="p-8">
      Loading chapter…
    </p>
  );
}
