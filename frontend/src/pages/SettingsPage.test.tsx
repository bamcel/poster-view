import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SettingsPage from "./SettingsPage";
import { api } from "../api/client";

vi.mock("../api/client", () => ({
  api: {
    listServers: vi.fn(),
    getLibraryVisibility: vi.fn(),
    setLibraryVisibility: vi.fn(),
  },
}));
vi.mock("../lib/toast", () => ({ useToast: () => ({ push: vi.fn() }) }));

beforeEach(() => {
  localStorage.clear();
  vi.mocked(api.listServers).mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("previews a palette color and saves it as a selectable custom theme", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <SettingsPage />
      </QueryClientProvider>
    </MemoryRouter>,
  );

  fireEvent.click(screen.getByRole("button", { name: "Appearance" }));
  const themeEditor = screen.getByLabelText("Theme JSON") as HTMLTextAreaElement;
  expect(themeEditor.value).toContain('"name": "Gotham"');
  expect(themeEditor.style.fontSize).toBe("1.5rem");

  fireEvent.change(screen.getByLabelText("Choose Accent color"), { target: { value: "#ff3366" } });
  expect(document.documentElement.style.getPropertyValue("--color-accent")).toBe("#FF3366");

  fireEvent.change(screen.getByPlaceholderText("My theme"), { target: { value: "Movie Night" } });
  fireEvent.click(screen.getByRole("button", { name: "Save custom theme" }));
  expect(document.documentElement.dataset.theme).toBe("Movie Night");

  fireEvent.click(screen.getByLabelText("Select theme"));
  expect(screen.getByRole("button", { name: "Movie Night" })).toBeTruthy();
  client.clear();
});

it("restores the active settings tab from the URL", () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter initialEntries={["/settings?tab=appearance"]}>
      <QueryClientProvider client={client}>
        <SettingsPage />
      </QueryClientProvider>
    </MemoryRouter>,
  );

  expect(screen.getByRole("button", { name: "Appearance", pressed: true })).toBeTruthy();
  expect(screen.getByLabelText("Theme JSON")).toBeTruthy();
  client.clear();
});

it("keeps server libraries in a checkbox dropdown", async () => {
  vi.mocked(api.listServers).mockResolvedValue([
    {
      id: 1,
      name: "Jellyfin",
      type: "jellyfin",
      base_url: "http://jellyfin:8096",
      is_default: true,
      has_token: true,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    },
  ]);
  vi.mocked(api.getLibraryVisibility).mockResolvedValue({
    libraries: [
      { id: "movies", title: "Movies", type: "movie", visible: true },
      { id: "shows", title: "TV Shows", type: "show", visible: false },
    ],
  });
  vi.mocked(api.setLibraryVisibility).mockResolvedValue();

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <SettingsPage />
      </QueryClientProvider>
    </MemoryRouter>,
  );

  expect(await screen.findByText("1 of 2 shown")).toBeTruthy();
  fireEvent.click(screen.getByText("Libraries shown on the Libraries page"));
  fireEvent.click(screen.getByRole("checkbox", { name: "TV Shows" }));

  await waitFor(() => expect(api.setLibraryVisibility).toHaveBeenCalledWith(1, []));
  client.clear();
});
