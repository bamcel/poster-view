import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SettingsPage from "./SettingsPage";
import { api } from "../api/client";

vi.mock("../api/client", () => ({
  api: {
    listServers: vi.fn(),
    createServer: vi.fn(),
    updateServer: vi.fn(),
    testServerAdhoc: vi.fn(),
    testServerSaved: vi.fn(),
    getLibraryVisibility: vi.fn(),
    setLibraryVisibility: vi.fn(),
    getArtworkSettings: vi.fn(),
    setArtworkSettings: vi.fn(),
    getArtworkCache: vi.fn(),
    setArtworkCache: vi.fn(),
    clearArtworkCache: vi.fn(),
    runArtworkWatchdog: vi.fn(),
    cancelArtworkWatchdog: vi.fn(),
    posterdbStatus: vi.fn(),
    posterdbLogin: vi.fn(),
    testArtworkProvider: vi.fn(),
    deleteServer: vi.fn(),
    appearanceSettings: vi.fn(),
    saveAppearanceSettings: vi.fn(),
  },
}));
vi.mock("../lib/toast", () => ({ useToast: () => ({ push: vi.fn() }) }));

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.mocked(api.listServers).mockResolvedValue([]);
  const appearance = { configured: true, backdrops_enabled: false, panel_solidity: 40, panel_blur: 12, panel_overlay: 0, backdrop_overlay: 72, theme_name: "Everforest", custom_themes_json: "[]" };
  vi.mocked(api.appearanceSettings).mockResolvedValue(appearance);
  vi.mocked(api.saveAppearanceSettings).mockImplementation(async (settings) => settings);
  vi.mocked(api.posterdbStatus).mockResolvedValue({ configured: true, logged_in: false, email: "test@example.test", message: "" });
  vi.mocked(api.getArtworkSettings).mockResolvedValue({
    fanart_configured: false,
    tvdb_configured: false,
    comicvine_configured: false,
    default_provider: "posterdb",
    ereader_default_provider: "anilist-manga",
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
  fireEvent.click(screen.getByLabelText("Toggle JSON Editor"));
  const themeEditor = screen.getByLabelText("JSON Editor") as HTMLTextAreaElement;
  expect(themeEditor.value).toContain('"name": "Everforest"');
  expect(themeEditor.style.fontSize).toBe("0.5625rem");
  expect(themeEditor.style.lineHeight).toBe("0.75rem");

  fireEvent.change(screen.getByLabelText("Choose Accent color"), { target: { value: "#ff3366" } });
  expect(document.documentElement.style.getPropertyValue("--color-accent")).toBe("#FF3366");
  fireEvent.click(screen.getByLabelText("Select Color Label"));
  const accentOption = screen.getByRole("button", { name: /^Accent$/ });
  expect((accentOption.querySelector("span") as HTMLElement).style.backgroundColor).toBe("rgb(255, 51, 102)");
  fireEvent.click(screen.getByRole("button", { name: /^Border$/ }));
  expect(screen.getByLabelText("Choose Border color")).toBeTruthy();
  expect(screen.getByLabelText("Select Color Label").closest("details")?.open).toBe(false);

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
  const themeJsonToggle = screen.getByLabelText("Toggle JSON Editor");
  expect(themeJsonToggle.className).toContain("h-10");
  expect(themeJsonToggle.closest("details")?.open).toBe(false);
  fireEvent.click(themeJsonToggle);
  expect(themeJsonToggle.closest("details")?.open).toBe(true);
  expect(screen.getByLabelText("JSON Editor")).toBeTruthy();
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

it("persists and resets Dashboard appearance controls", () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<MemoryRouter><QueryClientProvider client={client}><SettingsPage /></QueryClientProvider></MemoryRouter>);

  expect(screen.getByRole("button", { name: "Server", pressed: true })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Server" })).toBeTruthy();
  expect(screen.queryByRole("switch", { name: "Show Backdrops" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Appearance" }));
  expect(screen.getByRole("heading", { name: "Dashboard" })).toBeTruthy();
  const backdropSwitch = screen.getByRole("switch", { name: "Show Backdrops" });
  expect(backdropSwitch.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(backdropSwitch);
  expect(backdropSwitch.getAttribute("aria-checked")).toBe("true");
  expect(localStorage.getItem("posterview.dashboardBackdropEnabled")).toBe("true");
  fireEvent.change(screen.getByLabelText("Panel Color"), { target: { value: "65" } });
  fireEvent.change(screen.getByLabelText("Panel Blur"), { target: { value: "20" } });
  fireEvent.change(screen.getByLabelText("Panel Overlay"), { target: { value: "80" } });
  fireEvent.change(screen.getByLabelText("Backdrop Overlay"), { target: { value: "75" } });
  expect(localStorage.getItem("posterview.panelSolidity")).toBe("65");
  expect(localStorage.getItem("posterview.backdropBlur")).toBe("20");
  expect(localStorage.getItem("posterview.panelOverlay")).toBe("80");
  expect(localStorage.getItem("posterview.darkOverlay")).toBe("75");
  fireEvent.click(screen.getByRole("button", { name: "Reset to default" }));
  expect(backdropSwitch.getAttribute("aria-checked")).toBe("false");
  expect(localStorage.getItem("posterview.panelSolidity")).toBe("40");
  expect(localStorage.getItem("posterview.backdropBlur")).toBe("12");
  expect(localStorage.getItem("posterview.panelOverlay")).toBe("0");
  expect(localStorage.getItem("posterview.darkOverlay")).toBe("72");
  client.clear();
});

it("remembers the active settings tab for the browser session", () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const first = render(
    <MemoryRouter><QueryClientProvider client={client}><SettingsPage /></QueryClientProvider></MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Appearance" }));
  expect(sessionStorage.getItem("posterview.settingsTab")).toBe("appearance");
  first.unmount();

  render(
    <MemoryRouter><QueryClientProvider client={client}><SettingsPage /></QueryClientProvider></MemoryRouter>,
  );
  expect(screen.getByRole("button", { name: "Appearance", pressed: true })).toBeTruthy();
  client.clear();
});

it("saves the per-server NFO metadata setting", async () => {
  vi.mocked(api.createServer).mockResolvedValue({
    id: 1, name: "Manga", type: "emby", base_url: "http://emby:8096",
    is_default: true, nfo_metadata_enabled: true, has_token: true, created_at: "", updated_at: "",
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<MemoryRouter><QueryClientProvider client={client}><SettingsPage /></QueryClientProvider></MemoryRouter>);

  fireEvent.click(await screen.findByRole("button", { name: "Add server" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Manga" } });
  fireEvent.change(screen.getByLabelText("Server URL"), { target: { value: "http://emby:8096" } });
  fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "secret" } });
  fireEvent.click(screen.getByRole("checkbox", { name: /Enable NFO Metadata/ }));
  fireEvent.click(screen.getByRole("button", { name: "Add server" }));

  await waitFor(() => expect(api.createServer).toHaveBeenCalledWith(expect.objectContaining({
    nfo_metadata_enabled: true,
  })));
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
      nfo_metadata_enabled: false,
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

it("places Show Providers at the top of Search Providers instead of Server or Database", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <SettingsPage />
      </QueryClientProvider>
    </MemoryRouter>,
  );

  expect(screen.queryByText("Show Providers")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Search Providers" }));
  const providers = await screen.findByRole("heading", { name: "Show Providers" });
  const section = providers.closest("section")!;
  expect(section.querySelector("h3")).toBe(providers);
  fireEvent.click(screen.getByRole("button", { name: "Database" }));
  expect(screen.queryByText("Show Providers")).toBeNull();
  client.clear();
});

it("shows an independent cache panel and cancellation control for each server", async () => {
  vi.mocked(api.listServers).mockResolvedValue([{
    id: 7,
    name: "Jellyfin",
    type: "jellyfin",
    base_url: "http://jellyfin:8096",
    is_default: true,
    nfo_metadata_enabled: false,
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

  expect((await screen.findByRole("heading", { name: "Jellyfin" })).classList.contains("text-white")).toBe(true);
  fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(api.cancelArtworkWatchdog).toHaveBeenCalledWith(7));
  expect(await screen.findByText("Syncing Artwork: Stopping")).toBeTruthy();
  client.clear();
});

it("keeps each provider test result inside its own card", async () => {
  vi.mocked(api.getArtworkSettings).mockResolvedValue({ fanart_configured: true, tvdb_configured: true, comicvine_configured: true, default_provider: "fanart", ereader_default_provider: "comicvine", enabled_providers: ["fanart", "tvdb", "comicvine"] });
  vi.mocked(api.testArtworkProvider).mockImplementation(async ({ provider }) => ({ ok: provider !== "tvdb", message: provider === "tvdb" ? "TheTVDB rejected the credentials." : `${provider} connected.` }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<MemoryRouter initialEntries={["/settings?tab=sources"]}><QueryClientProvider client={client}><SettingsPage /></QueryClientProvider></MemoryRouter>);
  const fanart = (await screen.findByRole("heading", { name: "Fanart.tv" })).parentElement!;
  const tvdb = screen.getByRole("heading", { name: "TheTVDB" }).parentElement!;
  await waitFor(() => expect(within(fanart).getByRole("button", { name: "Test Connection" }).hasAttribute("disabled")).toBe(false));
  fireEvent.click(within(fanart).getByRole("button", { name: "Test Connection" }));
  expect(await within(fanart).findByText("fanart connected.", { exact: false })).toBeTruthy();
  fireEvent.click(within(tvdb).getByRole("button", { name: "Test Connection" }));
  expect(await within(tvdb).findByText("TheTVDB rejected the credentials.", { exact: false })).toBeTruthy();
  expect(within(fanart).queryByText("TheTVDB rejected the credentials.", { exact: false })).toBeNull();
  expect(within(fanart).getByText("fanart connected.", { exact: false })).toBeTruthy();
  client.clear();
});

it("identifies the server and affected data before deleting its connection", async () => {
  const server = { id: 19, name: "Family Movies", type: "jellyfin" as const, base_url: "http://family:8096", is_default: false, nfo_metadata_enabled: false, has_token: true, created_at: "", updated_at: "" };
  vi.mocked(api.listServers).mockResolvedValue([server]);
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<MemoryRouter><QueryClientProvider client={client}><SettingsPage /></QueryClientProvider></MemoryRouter>);
  fireEvent.click(await screen.findByRole("button", { name: "Delete Family Movies" }));
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining('"Family Movies" (http://family:8096, ID 19)'));
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining("artwork cache, and cached media-server images"));
  expect(api.deleteServer).not.toHaveBeenCalled();
  confirm.mockRestore();
  client.clear();
});

it("confirms a specific server cache and keeps another server's browser cache intact", async () => {
  const servers = [19, 31].map(id => ({ id, name: `Family ${id}`, type: "jellyfin" as const, base_url: `http://family-${id}:8096`, is_default: false, nfo_metadata_enabled: false, has_token: true, created_at: "", updated_at: "" }));
  vi.mocked(api.listServers).mockResolvedValue(servers);
  vi.mocked(api.getArtworkCache).mockImplementation(async id => ({ server_id: id, server_name: `Family ${id}`, max_mb: 250, ttl_days: 30, used_bytes: 2048, file_count: 2, watchdog_enabled: false, watchdog_interval_hours: 24, watchdog_running: false, watchdog_state: "idle", watchdog_progress_current: 0, watchdog_progress_total: 0, watchdog_cancel_requested: false }));
  vi.mocked(api.clearArtworkCache).mockResolvedValue({ cleared_bytes: 2048, cleared_files: 2 });
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const artworkA = ["artwork", "mediux", 19, "one"];
  const artworkB = ["artwork", "mediux", 31, "one"];
  client.setQueryData(artworkA, "A");
  client.setQueryData(artworkB, "B");
  render(<MemoryRouter initialEntries={["/settings?tab=database"]}><QueryClientProvider client={client}><SettingsPage /></QueryClientProvider></MemoryRouter>);
  const card = (await screen.findByRole("heading", { name: "Family 19" })).parentElement!;
  const clear = within(card).getByRole("button", { name: "Clear cache" });
  await waitFor(() => expect(clear.hasAttribute("disabled")).toBe(false));
  fireEvent.click(clear);
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining('"Family 19" (http://family-19:8096, ID 19)'));
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining("2.0 KB"));
  expect(api.clearArtworkCache).not.toHaveBeenCalled();
  confirm.mockReturnValue(true);
  fireEvent.click(clear);
  await waitFor(() => expect(api.clearArtworkCache).toHaveBeenCalledWith(19));
  await waitFor(() => expect(client.getQueryData(artworkA)).toBeUndefined());
  expect(client.getQueryData(artworkB)).toBe("B");
  confirm.mockRestore();
  client.clear();
});
