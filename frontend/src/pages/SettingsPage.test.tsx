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
    getArtworkSettings: vi.fn(),
    setArtworkSettings: vi.fn(),
    getArtworkCache: vi.fn(),
    setArtworkCache: vi.fn(),
    clearArtworkCache: vi.fn(),
    runArtworkWatchdog: vi.fn(),
    cancelArtworkWatchdog: vi.fn(),
  },
}));
vi.mock("../lib/toast", () => ({ useToast: () => ({ push: vi.fn() }) }));

beforeEach(() => {
  localStorage.clear();
  vi.mocked(api.listServers).mockResolvedValue([]);
  vi.mocked(api.getArtworkSettings).mockResolvedValue({
    fanart_configured: false,
    tvdb_configured: false,
    comicvine_configured: false,
    default_provider: "posterdb",
    enabled_providers: ["posterdb"],
  });
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
  expect(themeEditor.style.fontSize).toBe("0.75rem");

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

it("keeps the add server form collapsed until requested", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <SettingsPage />
      </QueryClientProvider>
    </MemoryRouter>,
  );

  expect(screen.queryByPlaceholderText("Living Room Jellyfin")).toBeNull();
  fireEvent.click(await screen.findByRole("button", { name: "Add server" }));
  expect(screen.getByPlaceholderText("Living Room Jellyfin")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByPlaceholderText("Living Room Jellyfin")).toBeNull();
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
  fireEvent.click(screen.getByText("Show Libraries"));
  fireEvent.click(screen.getByRole("checkbox", { name: "TV Shows" }));

  await waitFor(() => expect(api.setLibraryVisibility).toHaveBeenCalledWith(1, []));
  client.clear();
});

it("places artwork database controls in Server Setup instead of Cache Services", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <SettingsPage />
      </QueryClientProvider>
    </MemoryRouter>,
  );

  expect(await screen.findByText("Enabled artwork databases")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cache Services" }));
  expect(screen.queryByText("Enabled artwork databases")).toBeNull();
  client.clear();
});

it("shows an independent cache panel and cancellation control for each server", async () => {
  vi.mocked(api.listServers).mockResolvedValue([{
    id: 7,
    name: "Jellyfin",
    type: "jellyfin",
    base_url: "http://jellyfin:8096",
    is_default: true,
    has_token: true,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  }]);
  vi.mocked(api.getArtworkCache).mockResolvedValue({
    server_id: 7,
    server_name: "Jellyfin",
    max_mb: 500,
    ttl_days: 30,
    used_bytes: 1024,
    file_count: 2,
    watchdog_enabled: true,
    watchdog_interval_hours: 24,
    watchdog_running: true,
    watchdog_last_run: null,
    watchdog_last_message: null,
    watchdog_progress_current: 1,
    watchdog_progress_total: 10,
    watchdog_current_title: "Movie",
    watchdog_cancel_requested: false,
  });
  vi.mocked(api.cancelArtworkWatchdog).mockResolvedValue({
    ok: true,
    message: "Watchdog cancellation requested.",
    providers_warmed: 0,
  });

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter initialEntries={["/settings?tab=database"]}>
      <QueryClientProvider client={client}>
        <SettingsPage />
      </QueryClientProvider>
    </MemoryRouter>,
  );

  expect((await screen.findByText("Jellyfin Cache")).classList.contains("text-white")).toBe(true);
  fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(api.cancelArtworkWatchdog).toHaveBeenCalledWith(7));
  client.clear();
});
