import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { EpubChapter } from "./ReaderPages";
import { defaults } from "../lib/reader";
import { readerContent } from "../lib/readerContent";

it("preserves in-book image references without live resource URLs", () => {
  const content=readerContent('<p>Hello</p><img src="../images/page.jpg"><img src="https://tracker.test/pixel">','OPS/text/one.xhtml');
  expect(content.querySelectorAll("img")[0].getAttribute("data-reader-resource")).toBe("OPS/images/page.jpg");
  expect(content.querySelector("img[src]")).toBeNull();
  expect(content.innerHTML).not.toContain("tracker.test");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("isolates EPUB content and removes scripts, forms, styles and remote images", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue({
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
