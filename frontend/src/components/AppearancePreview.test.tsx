import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation } from "react-router-dom";
import { LibraryBackdrop, Link, useNavigate, useParams, useSearchParams } from "../lib/libraryNavigation";
import AppearancePreview from "./AppearancePreview";

vi.mock("../pages/MediaLibraryPage", () => ({ default: function Library() {
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
afterEach(cleanup);

function Location() { return <output data-testid="outer-location">{useLocation().pathname}{useLocation().search}</output>; }

it("navigates library, series and seasons without replacing Settings or losing library state", () => {
  const close = vi.fn();
  render(<MemoryRouter initialEntries={["/settings?tab=appearance"]}><Location /><AppearancePreview onClose={close} /></MemoryRouter>);
  expect(screen.getByRole("region", { name: "Live Media Library preview" }).contains(screen.getByTestId("preview-backdrop"))).toBe(true);
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
