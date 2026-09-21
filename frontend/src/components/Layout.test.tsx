import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import AuthGate from "./AuthGate";
import Layout from "./Layout";
import { api } from "../api/client";

vi.mock("../api/client", () => ({ api: { authStatus: vi.fn() } }));
vi.mock("../lib/serverContext", () => ({ useServers: () => ({ servers: [], selectedId: 7, setSelectedId: vi.fn() }) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); sessionStorage.clear(); });

function CurrentLocation() {
  const location = useLocation();
  return <p>{location.pathname}{location.search}</p>;
}

it.each([true, false])("shows Sign out only when password_required is true (%s)", async (required) => {
  vi.mocked(api.authStatus).mockResolvedValue({ authenticated: true, password_required: required });
  render(<MemoryRouter><AuthGate><Layout /></AuthGate></MemoryRouter>);
  await screen.findAllByText("Settings");
  expect(screen.queryAllByRole("button", { name: "Sign out" })).toHaveLength(required ? 2 : 0);
});

it("updates both sign-out controls when the security policy changes", async () => {
  vi.mocked(api.authStatus).mockResolvedValue({ authenticated: true, password_required: true });
  render(<MemoryRouter><AuthGate><Layout /></AuthGate></MemoryRouter>);
  expect(await screen.findAllByRole("button", { name: "Sign out" })).toHaveLength(2);
  vi.mocked(api.authStatus).mockResolvedValue({ authenticated: true, password_required: false });
  fireEvent(window, new Event("posterview:security-changed"));
  await waitFor(() => expect(screen.queryAllByRole("button", { name: "Sign out" })).toHaveLength(0));
});

it("returns to the last selected series when reopening Dashboard", async () => {
  vi.mocked(api.authStatus).mockResolvedValue({ authenticated: true, password_required: false });
  render(
    <MemoryRouter initialEntries={["/server/7/item/classroom?return_library=novels"]}>
      <AuthGate>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/server/:serverId/item/:itemId" element={<CurrentLocation />} />
            <Route path="/settings" element={<CurrentLocation />} />
          </Route>
        </Routes>
      </AuthGate>
    </MemoryRouter>,
  );

  await screen.findByText("/server/7/item/classroom?return_library=novels");
  fireEvent.click(screen.getAllByText("Settings")[0]);
  await screen.findByText("/settings");
  fireEvent.click(screen.getAllByLabelText("Dashboard")[0]);
  expect(await screen.findByText("/server/7/item/classroom?return_library=novels")).toBeTruthy();
});

it("makes both PosterView logos link to the Dashboard root", async () => {
  vi.mocked(api.authStatus).mockResolvedValue({ authenticated: true, password_required: false });
  sessionStorage.setItem("posterview.libraryTab.7", "manga");
  sessionStorage.setItem("posterview.dashboardLocation.7", "/server/7/item/manga");
  render(
    <MemoryRouter initialEntries={["/settings"]}>
      <AuthGate>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<CurrentLocation />} />
            <Route path="/settings" element={<CurrentLocation />} />
          </Route>
        </Routes>
      </AuthGate>
    </MemoryRouter>,
  );

  const logoLinks = await screen.findAllByRole("link", { name: "Go to Dashboard" });
  expect(logoLinks).toHaveLength(2);
  fireEvent.click(logoLinks[0]);
  expect(await screen.findByText("/")).toBeTruthy();
  expect(sessionStorage.getItem("posterview.libraryTab.7")).toBeNull();
  expect(sessionStorage.getItem("posterview.dashboardLocation.7")).toBe("/");
});
