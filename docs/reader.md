# Book reader

Open a book-style series on Dashboard and choose **Read** under a volume. An individual
book detail page also has **Read Book**. The reader opens separately from the artwork panel;
Back returns to the series. Files are resolved from the connected server's item ID, but the
actual PDF, EPUB or CBZ must be readable under PosterView's `/media` mount (or
`POSTERVIEW_MEDIA_DIR`). Server filesystem paths must match the mount. Audiobooks, CBR,
CB7, MOBI and DRM-protected files are not supported in this release.

## Controls

- PDF and CBZ: Book/Comic, Manga (right-to-left default), and Webtoon (vertical scrolling).
- Reading direction can be changed independently. The **Pages** toolbar menu offers One
  Page, Two Pages (1–2, 3–4), and Two Pages with First Page as Cover (1, 2–3, 4–5).
  These preferences are saved per book; narrow screens fall back to one page. Selecting a
  page layout exits Webtoon mode. Fit Page, Fit Width, zoom and webtoon gaps
  are in the settings drawer.
- EPUB: reflowed, sanitized chapter text with serif/sans-serif fonts, size, line spacing,
  dark/light/sepia reading themes. Previous/Next moves a screenful within a chapter, then
  moves to the adjacent chapter. Publisher CSS, scripts, forms, embedded media, external
  resources and SVG illustrations are not enabled. Fixed-layout/interactively scripted
  EPUBs are not faithful layout reproductions in this first release.
- Contents: chapter labels where available, PDF outline, page/chapter number entry,
  bookmarks and previous/next volume. Volume order is natural filename order in the same
  directory, not a guessed relationship across folders.
- Search: PDF text and EPUB chapters, up to 100 matching pages/chapters. EPUB results are
  highlighted. Image-only PDFs and CBZ files have no OCR search.
- Arrow keys navigate; swipe navigates image pages; Space toggles controls. Mouse wheel down
  turns right and up turns left, reversed for manga/right-to-left reading. Short wheel bursts
  are throttled to avoid skipping pages. Webtoon keeps vertical scrolling; Ctrl/Command-wheel
  remains available for browser zoom. Controls hide
  after inactivity, reappear on mouse movement, and remain keyboard-accessible. Fullscreen
  requires browser support.

## Progress and storage

Reading position, bookmarks (up to 100) and per-book preferences are stored in
`/config/reader.sqlite`, separately from the existing database. They are scoped to the
configured PosterView administrator identity; this baseline does not have separate household
user accounts. Devices using the same identity share progress. Concurrent readers use the
last successfully saved state. A detected size/modification-time change resets incompatible
positions and bookmarks with a notice. Renaming a source file creates a new reader identity.

Saving never writes the source book, companion images, NFO files or connected server records.
Back up `reader.sqlite` with the rest of `/config`. Failed progress saves show a retry action.

## Resource and security boundaries

All reader endpoints use the existing authentication middleware. File access is confined to
the configured media root; symlinks/junctions and traversal paths are rejected. PDFs support
HTTP byte ranges. Archives are accessed in place, never extracted to disk; entries are limited
to 32 MB, archives to 10,000 entries and 2 GB declared decompressed data, with a compression
ratio cap. EPUB XML documents are capped at 4 MB and DTDs are rejected. Chapter illustrations
are capped at 256 images / 64 MB. Raster pages above 64 megapixels are rejected except GIFs,
which rely on the entry-size limit. Long webtoon lists unmount offscreen image/canvas content.

EPUB HTML is sanitized with DOMPurify, stripped of publisher styles and remote resources,
and displayed in a scripts-disabled iframe with a restrictive content security policy.
PDF.js runs in its bundled worker. Its fonts, CMaps and decoders ship locally with the UI;
the reader does not require a CDN. PDF.js is Apache-2.0, DOMPurify is Apache-2.0/MPL-2.0,
and the Rust ZIP library is MIT. Upstream license notices remain in installed dependencies.

Real-library mobile and visual polish testing should cover tall webtoon pages, image-heavy
EPUB chapters, RTL spreads, large PDFs, file replacement, and network interruptions.
