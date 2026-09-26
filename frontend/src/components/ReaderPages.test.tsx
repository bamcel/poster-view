import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ComicPage, EpubChapter } from "./ReaderPages";
import { defaults } from "../lib/reader";
import { readerContent } from "../lib/readerContent";

it("preserves in-book image references without live resource URLs", () => {
  const content = readerContent(
    '<p>Hello</p><img src="../images/page.jpg"><img src="https://tracker.test/pixel">',
    "OPS/text/one.xhtml",
  );
  expect(
    content.querySelectorAll("img")[0].getAttribute("data-reader-resource"),
  ).toBe("OPS/images/page.jpg");
  expect(content.querySelector("img[src]")).toBeNull();
  expect(content.innerHTML).not.toContain("tracker.test");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("sizes a fitted comic to its actual aspect ratio without auto-margin gaps", () => {
  render(
    <ComicPage
      book={{
        id: "one",
        title: "One",
        format: "cbz",
        revision: "r",
        chapters: [{ name: "1.jpg", title: "Page 1" }],
      }}
      page={0}
      width={600}
      maxHeight={700}
    />,
  );
  const image = screen.getByAltText("Page 1") as HTMLImageElement;
  Object.defineProperties(image, {
    naturalWidth: { value: 1000 },
    naturalHeight: { value: 2000 },
  });
  fireEvent.load(image);
  expect(image.style.width).toBe("350px");
  expect(image.className).not.toContain("mx-auto");
  expect(image.style.objectFit).toBe("");
});
it("isolates EPUB content and removes scripts, forms, styles and remote images", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        `<html><body><script>alert(1)</script><style>body{background:url(https://tracker.test)}</style><form action='/api/settings'><input></form><p onclick='alert(1)'>Readable words</p><img src='https://tracker.test/pixel'><a href='javascript:alert(1)'>Unsafe</a></body></html>`,
    }),
  );
  render(
    <EpubChapter
      book={{
        id: "one",
        title: "One",
        format: "epub",
        revision: "r",
        chapters: [{ name: "one.xhtml", title: "Chapter One" }],
      }}
      page={0}
      settings={defaults}
      offset={0}
      onPosition={() => {}}
      onNavigate={() => {}}
      onKey={() => {}}
      search=""
    />,
  );
  const frame = (await screen.findByTitle("Chapter One")) as HTMLIFrameElement;
  await waitFor(() => expect(frame.srcdoc).toContain("Readable words"));
  expect(frame.getAttribute("sandbox")).toBe("allow-same-origin");
  expect(frame.srcdoc).not.toContain("<script");
  expect(frame.srcdoc).not.toContain("onclick");
  expect(frame.srcdoc).not.toContain("<form");
  expect(frame.srcdoc).not.toContain("tracker.test");
  expect(frame.srcdoc).not.toContain("javascript:");
  expect(frame.srcdoc).toContain("default-src 'none'");
});
