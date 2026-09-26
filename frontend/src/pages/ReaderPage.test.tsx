import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ReaderPage from "./ReaderPage";

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: {},
  getDocument: vi.fn(),
}));
vi.mock("../components/ReaderPages", () => ({
  ComicPage: ({ page }: { page: number }) => <div>Comic page {page + 1}</div>,
  PdfPage: () => null,
  EpubChapter: () => null,
  FlowPage: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));
const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollTo = vi.fn();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => ({
    ok: true,
    json: async () =>
      url.endsWith("/state")
        ? init?.method
          ? true
          : null
        : {
            id: "book",
            title: "Volume One",
            format: "cbz",
            revision: "version1",
            chapters: [
              { name: "1.jpg", title: "Page 1" },
              { name: "2.jpg", title: "Page 2" },
              { name: "3.jpg", title: "Page 3" },
            ],
            next: { id: "two", title: "Volume Two" },
          },
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});
function open() {
  return render(
    <MemoryRouter initialEntries={["/reader/book"]}>
      <Routes>
        <Route path="/reader/:bookId" element={<ReaderPage />} />
      </Routes>
    </MemoryRouter>,
  );
}
it("opens a book, navigates pages and persists a bookmark", async () => {
  open();
  await screen.findByText("Comic page 1");
  fireEvent.click(screen.getByRole("button", { name: "Next page" }));
  await screen.findByText("Comic page 2");
  fireEvent.click(screen.getByRole("button", { name: "Bookmark this page" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Contents and bookmarks" }),
  );
  expect(await screen.findByRole("button", { name: "Page 2" })).toBeTruthy();
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          url.endsWith("/state") &&
          init?.method === "PUT" &&
          JSON.parse(init.body).data.bookmarks.length === 1,
      ),
    ).toBe(true),
  );
});
it("restores the saved position", async () => {
  const base = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
    url.endsWith("/state") && !init
      ? {
          ok: true,
          json: async () => ({
            revision: "version1",
            data: { page: 2, offset: 0, bookmarks: [] },
          }),
        }
      : base(url, init),
  );
  open();
  await screen.findByText("Comic page 3");
  expect(screen.getByRole("button", { name: "Next Volume" })).toBeTruthy();
});
it("resets incompatible progress after a file replacement", async () => {
  const base = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
    url.endsWith("/state") && !init
      ? { ok: true, json: async () => ({ revision: "old", data: { page: 2 } }) }
      : base(url, init),
  );
  open();
  await screen.findByText("Comic page 1");
  expect(screen.getByText(/file changed since/)).toBeTruthy();
});
it("shows unsupported-file errors without modifying progress", async () => {
  fetchMock.mockResolvedValue({
    ok: false,
    json: async () => ({ detail: "Choose a PDF, EPUB, or CBZ file." }),
  });
  open();
  expect(
    await screen.findByText("Choose a PDF, EPUB, or CBZ file."),
  ).toBeTruthy();
  expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(
    false,
  );
});
