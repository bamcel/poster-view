import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import type {ReactNode} from "react";
import { useState } from "react";
import { act, cleanup, fireEvent, render as rtlRender, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation } from "react-router-dom";
import { LibraryBackdrop, Link, useNavigate, useParams, useSearchParams } from "../lib/libraryNavigation";
import AppearancePreview from "./AppearancePreview";

vi.mock("../lib/serverContext", () => ({ useServers: () => ({ servers: [], selectedId: null, setSelectedId: vi.fn() }) }));
let measure: () => void;
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { measure = callback; }
    observe() {}
    disconnect() {}
  });
});

vi.mock("../pages/DashboardPage", () => ({ default: function Library() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState("");
  return <><input aria-label="Filter titles" value={filter} onChange={event => setFilter(event.target.value)} />
    <button onClick={() => setParams({ lib: "tv", folder: "favorites" }, { replace: true })}>Choose library</button>
    <button onClick={() => navigate(`/server/7/item/show?${params}`)}>Open series</button>
    <LibraryBackdrop><div data-testid="preview-backdrop" /></LibraryBackdrop>
  </>;
} }));
vi.mock("../pages/ItemDetailPage", () => ({ default: function Series() {
  const params = useParams();
  const [search] = useSearchParams();
  return <><h2>Series {params.itemId}</h2><Link to={`/server/${params.serverId}/series/${params.itemId}/season/one?${search}`}>Open season</Link></>;
} }));
vi.mock("../pages/SeasonDetailPage", () => ({ default: function Season() {
  const params = useParams();
  const [search] = useSearchParams();
  return <h2>Season {params.seasonId}, library {search.get("lib")}, folder {search.get("folder")}</h2>;
} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function Location() { return <output data-testid="outer-location">{useLocation().pathname}{useLocation().search}</output>; }

it("navigates library, series and seasons without replacing Settings or losing library state", () => {
  const close = vi.fn();
  render(<MemoryRouter initialEntries={["/settings?tab=appearance"]}><Location /><AppearancePreview onClose={close} /></MemoryRouter>);
  expect(screen.getByRole("region", { name: "Live Dashboard preview" }).contains(screen.getByTestId("preview-backdrop"))).toBe(true);
  fireEvent.change(screen.getByLabelText("Filter titles"), { target: { value: "Example" } });
  fireEvent.click(screen.getByText("Choose library"));
  fireEvent.click(screen.getByText("Open series"));
  expect(screen.getByRole("heading", { name: "Series show" })).toBeTruthy();
  fireEvent.click(screen.getByText("Open season"));
  expect(screen.getByRole("heading", { name: "Season one, library tv, folder favorites" })).toBeTruthy();
  expect(screen.getByTestId("outer-location").textContent).toBe("/settings?tab=appearance");
  fireEvent.click(screen.getByLabelText("Back in preview"));
  expect(screen.getByRole("heading", { name: "Series show" })).toBeTruthy();
  fireEvent.click(screen.getByLabelText("Back in preview"));
  expect((screen.getByLabelText("Filter titles") as HTMLInputElement).value).toBe("Example");
  fireEvent.click(screen.getByLabelText("Close split view"));
  expect(close).toHaveBeenCalledOnce();
});

it("fits the full desktop by default and selects the icon only for pane-sized preview", () => {
  vi.stubGlobal("innerWidth", 1600);
  vi.stubGlobal("innerHeight", 900);
  let paneWidth = 640;
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => paneWidth);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  render(<MemoryRouter initialEntries={["/settings?tab=appearance"]}><Location /><AppearancePreview onClose={vi.fn()} /></MemoryRouter>);
  fireEvent.change(screen.getByLabelText("Filter titles"), { target: { value: "Example" } });
  fireEvent.click(screen.getByText("Open series"));
  const toggle = screen.getByRole("button", { name: "Pane-sized preview" });
  const frame = screen.getByTestId("preview-desktop-frame");
  expect(frame.style.width).toBe("1600px");
  expect(frame.style.transform).toBe("scale(0.4)");
  expect(toggle.getAttribute("aria-pressed")).toBe("false");
  expect(screen.getByRole("heading", { name: "Series show" })).toBeTruthy();
  const sidebar = frame.querySelector("aside")!;
  expect(sidebar).toBeTruthy();
  fireEvent.click(within(sidebar).getByRole("link", { name: "Settings" }));
  expect(screen.getByRole("heading", { name: "Series show" })).toBeTruthy();
  expect(screen.getByTestId("outer-location").textContent).toBe("/settings?tab=appearance");
  paneWidth = 800;
  act(() => measure());
  expect(frame.style.transform).toBe("scale(0.5)");
  fireEvent.click(within(sidebar).getByRole("link", { name: "Home" }));
  expect((screen.getByLabelText("Filter titles") as HTMLInputElement).value).toBe("Example");
  fireEvent.click(toggle);
  expect(frame.style.transform).toBe("");
  expect(toggle.getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(toggle);
  expect(frame.style.transform).toBe("scale(0.5)");
  expect(toggle.getAttribute("aria-pressed")).toBe("false");
});

function render(node:ReactNode){return rtlRender(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>);}

