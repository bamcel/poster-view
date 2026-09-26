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
it("saves the final page as 100 percent for automatic completion", async () => {
  open();
  const slider = await screen.findByLabelText("Reading position");
  fireEvent.change(slider, { target: { value: "2" } });
  await waitFor(() => {
    expect(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith("/state") && init?.method === "PUT" && JSON.parse(String(init.body)).data.progress === 100)).toBe(true);
  });
});
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
it("offers labeled toolbar actions and all three page layouts", async () => {
  open();
  await screen.findByText("Comic page 1");
  for (const label of [
    "Contents",
    "Bookmark",
    "Pages",
    "Settings",
    "Fullscreen",
  ])
    expect(screen.getByText(label)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Page layout" }));
  fireEvent.click(screen.getByRole("radio", { name: "Two Pages" }));
  fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
  expect(screen.getByText("Comic page 1")).toBeTruthy();
  expect(screen.getByText("Comic page 2")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Next page" }));
  expect(screen.getByText("Comic page 3")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
  expect(screen.getByText("Comic page 1")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Page layout" }));
  fireEvent.click(
    screen.getByRole("radio", { name: /Two Pages with First Page as Cover/ }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
  expect(screen.queryByText("Comic page 2")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Next page" }));
  expect(screen.getByText("Comic page 2")).toBeTruthy();
  expect(screen.getByText("Comic page 3")).toBeTruthy();
});

it("turns with the mouse wheel, throttles bursts, and reverses in manga mode", async () => {
  let clock = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  open();
  await screen.findByText("Comic page 1");
  fireEvent.wheel(screen.getByText("Comic page 1"), { deltaY: 100 });
  expect(screen.getByText("Comic page 2")).toBeTruthy();
  fireEvent.wheel(screen.getByText("Comic page 2"), { deltaY: 100 });
  expect(screen.queryByText("Comic page 3")).toBeNull();
  clock += 400;
  fireEvent.wheel(screen.getByText("Comic page 2"), { deltaY: -100 });
  expect(screen.getByText("Comic page 1")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Reader settings" }));
  fireEvent.change(screen.getByLabelText("Reading Mode"), {
    target: { value: "manga" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
  clock += 400;
  fireEvent.wheel(screen.getByText("Comic page 1"), { deltaY: -100 });
  expect(screen.getByText("Comic page 2")).toBeTruthy();
  clock += 400;
  fireEvent.wheel(screen.getByText("Comic page 2"), {
    deltaY: 100,
    ctrlKey: true,
  });
  expect(screen.getByText("Comic page 2")).toBeTruthy();
  fireEvent.wheel(screen.getByText("Comic page 2"), { deltaY: 100 });
  expect(screen.getByText("Comic page 1")).toBeTruthy();
});

it("keeps native vertical wheel scrolling in webtoon mode", async () => {
  open();
  await screen.findByText("Comic page 1");
  fireEvent.click(screen.getByRole("button", { name: "Reader settings" }));
  fireEvent.change(screen.getByLabelText("Reading Mode"), {
    target: { value: "webtoon" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
  const event = new WheelEvent("wheel", {
    deltaY: 100,
    bubbles: true,
    cancelable: true,
  });
  screen.getByText("Comic page 1").dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
});

it("sets mode-specific directions while allowing manual overrides", async () => {
  open();
  await screen.findByText("Comic page 1");
  fireEvent.click(screen.getByRole("button", { name: "Reader settings" }));
  const mode = screen.getByLabelText("Reading Mode");
  const direction = screen.getByLabelText(
    "Reading Direction",
  ) as HTMLSelectElement;
  fireEvent.change(mode, { target: { value: "manga" } });
  expect(direction.value).toBe("rtl");
  fireEvent.change(mode, { target: { value: "book" } });
  expect(direction.value).toBe("ltr");
  fireEvent.change(direction, { target: { value: "rtl" } });
  expect(direction.value).toBe("rtl");
  fireEvent.change(mode, { target: { value: "comic" } });
  expect(direction.value).toBe("ltr");
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
