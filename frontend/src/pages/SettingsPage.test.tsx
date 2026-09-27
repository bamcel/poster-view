import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SettingsPage from "./SettingsPage";
import { api } from "../api/client";
import { creditsApi } from "../api/credits";
vi.mock("../api/credits", () => ({ creditsApi: { settings: vi.fn(), saveToken: vi.fn() } }));
import type { AppearanceSettings } from "../types";

vi.mock("../components/AppearancePreview", () => ({ default: ({ onClose }: { onClose: () => void }) => <section aria-label="Live Media Library preview"><button onClick={onClose}>Close split view</button></section> }));

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
  vi.mocked(creditsApi.settings).mockResolvedValue({ tmdb_configured: false, tvdb_configured: false });
  localStorage.clear();
  sessionStorage.clear();
  vi.mocked(api.listServers).mockResolvedValue([]);
  const appearance = { configured: true, backdrops_enabled: false, panel_solidity: 40, panel_blur: 12, panel_overlay: 0, backdrop_overlay: 72, pill_background_opacity: 5, theme_name: "Everforest", custom_themes_json: "[]" };
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

it("opens, resizes and closes the desktop preview while retaining Appearance controls", () => {
  const originalWidth = window.innerWidth;
  Object.defineProperty(window, "innerWidth", { value: 1600, configurable: true });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<MemoryRouter initialEntries={["/settings?tab=appearance"]}><QueryClientProvider client={client}><SettingsPage /></QueryClientProvider></MemoryRouter>);
  fireEvent.click(screen.getByRole("button", { name: "Live Preview" }));
  expect(screen.getByRole("region", { name: "Live Media Library preview" })).toBeTruthy();
  const divider = screen.getByRole("separator");
  fireEvent.keyDown(divider, { key: "ArrowRight" });
  expect(divider.getAttribute("aria-valuenow")).toBe("42");
  expect(screen.getByRole("slider", { name: "Panel Blur" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Close split view" }));
  expect(screen.queryByRole("region", { name: "Live Media Library preview" })).toBeNull();
  expect(screen.getByRole("button", { name: "Live Preview" }).getAttribute("aria-pressed")).toBe("false");
  Object.defineProperty(window, "innerWidth", { value: originalWidth, configurable: true });
  client.clear();
});

it("remembers whether Live Preview is open when returning to Appearance", () => {
  const originalWidth = window.innerWidth;
  Object.defineProperty(window, "innerWidth", { value: 1600, configurable: true });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const mount = () => render(<MemoryRouter initialEntries={["/settings?tab=appearance"]}><QueryClientProvider client={client}><SettingsPage /></QueryClientProvider></MemoryRouter>);
  const first = mount();
  fireEvent.click(screen.getByRole("button", { name: "Live Preview" }));
  first.unmount();
  const second = mount();
  expect(screen.getByRole("region", { name: "Live Media Library preview" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Server" }));
  fireEvent.click(screen.getByRole("button", { name: "Appearance" }));
  expect(screen.getByRole("button", { name: "Live Preview" }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Close split view" }));
  second.unmount();
  mount();
  expect(screen.queryByRole("region", { name: "Live Media Library preview" })).toBeNull();
  Object.defineProperty(window, "innerWidth", { value: originalWidth, configurable: true });
  client.clear();
});

it("coalesces slider saves and does not apply an older response over the latest adjustment", async () => {
  const pending: { settings: AppearanceSettings; resolve: (settings: AppearanceSettings) => void }[] = [];
  vi.mocked(api.saveAppearanceSettings).mockImplementation(settings => new Promise(resolve => pending.push({ settings, resolve })));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<MemoryRouter initialEntries={["/settings?tab=appearance"]}><QueryClientProvider client={client}><SettingsPage /></QueryClientProvider></MemoryRouter>);
  const slider = screen.getByRole("slider", { name: "Panel Blur" }) as HTMLInputElement;
  await waitFor(() => expect(slider.value).toBe("12"));
  fireEvent.change(slider, { target: { value: "14" } });
  fireEvent.change(slider, { target: { value: "18" } });
  fireEvent.change(slider, { target: { value: "24" } });
  expect(pending).toHaveLength(1);
  await act(async () => pending[0].resolve(pending[0].settings));
  expect(slider.value).toBe("24");
  expect(pending).toHaveLength(2);
  expect(pending[1].settings.panel_blur).toBe(24);
  await act(async () => pending[1].resolve(pending[1].settings));
  await waitFor(() => expect(client.getQueryData<AppearanceSettings>(["appearance-settings"])?.panel_blur).toBe(24));
  client.clear();
});

it("previews, saves and resets pill background opacity", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<MemoryRouter initialEntries={["/settings?tab=appearance"]}><QueryClientProvider client={client}><SettingsPage /></QueryClientProvider></MemoryRouter>);
  const slider = screen.getByRole("slider", { name: "Pill Background" }) as HTMLInputElement;
  await waitFor(() => expect(client.getQueryData(["appearance-settings"])).toBeTruthy());
  expect(slider.value).toBe("5");
  fireEvent.change(slider, { target: { value: "65" } });
  expect(document.documentElement.style.getPropertyValue("--pill-background-opacity")).toBe("65%");
  await waitFor(() => expect(api.saveAppearanceSettings).toHaveBeenCalledWith(expect.objectContaining({ pill_background_opacity: 65 })));
  fireEvent.click(screen.getByRole("button", { name: "Reset to default" }));
  await waitFor(() => expect(slider.value).toBe("5"));
  expect(document.documentElement.style.getPropertyValue("--pill-background-opacity")).toBe("5%");
  await waitFor(() => expect(api.saveAppearanceSettings).toHaveBeenLastCalledWith(expect.objectContaining({ pill_background_opacity: 5 })));
  client.clear();
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

it("persists and resets Media Library appearance controls", () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<MemoryRouter><QueryClientProvider client={client}><SettingsPage /></QueryClientProvider></MemoryRouter>);

  expect(screen.getByRole("button", { name: "Server", pressed: true })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Server" })).toBeTruthy();
  expect(screen.queryByRole("switch", { name: "Show Backdrops" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Appearance" }));
  expect(screen.getByRole("heading", { name: "Media Library" })).toBeTruthy();
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

it("places compact provider choices above collapsed connections and remembers expanded rows", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <SettingsPage />
      </QueryClientProvider>
    </MemoryRouter>,
  );

  expect(screen.queryByRole("group", { name: /Poster providers/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Search Providers" }));
  const providers = await screen.findByRole("group", { name: /Poster providers/ });
  expect(screen.getByRole("group", { name: /eReader providers/ })).toBeTruthy();
  expect(within(providers).queryByRole("checkbox")).toBeNull();
  expect(within(screen.getByRole("group", { name: /eReader providers/ })).queryByRole("checkbox")).toBeNull();
  expect(within(providers).getAllByRole("option")).toHaveLength(5);
  for (const name of ["AniList", "AniList Manga", "MediUX", "MangaDex", "VIZ"]) {
    const row = screen.getByRole("region", { name: `${name} connection` });
    expect(within(row).getByText("No credentials required")).toBeTruthy();
    expect(within(row).queryByRole("img")).toBeNull();
  }
  expect(providers.compareDocumentPosition(screen.getByRole("heading", { name: "Accounts & connections" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Test Connection" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Configure ThePosterDB" }));
  expect(screen.getByRole("textbox", { name: "Email / username" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Database" }));
  expect(screen.queryByRole("group", { name: /Poster providers/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Search Providers" }));
  expect(screen.getByRole("button", { name: "Configure ThePosterDB" }).getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByRole("button", { name: "Configure Fanart.tv" }).getAttribute("aria-expanded")).toBe("false");
  client.clear();
});

it("keeps each provider test result inside its own card", async () => {
  vi.mocked(api.getArtworkSettings).mockResolvedValue({ fanart_configured: true, tvdb_configured: true, comicvine_configured: true, default_provider: "fanart", ereader_default_provider: "comicvine", enabled_providers: ["fanart", "tvdb", "comicvine"] });
  vi.mocked(api.testArtworkProvider).mockImplementation(async ({ provider }) => ({ ok: provider !== "tvdb", message: provider === "tvdb" ? "TheTVDB rejected the credentials." : `${provider} connected.` }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<MemoryRouter initialEntries={["/settings?tab=sources"]}><QueryClientProvider client={client}><SettingsPage /></QueryClientProvider></MemoryRouter>);
  fireEvent.click(await screen.findByRole("button", { name: "Configure Fanart.tv" }));
  fireEvent.click(screen.getByRole("button", { name: "Configure TheTVDB" }));
  const fanart = screen.getByRole("region", { name: "Fanart.tv connection" });
  const tvdb = screen.getByRole("region", { name: "TheTVDB connection" });
  await waitFor(() => expect(within(fanart).getByRole("button", { name: "Test Connection" }).hasAttribute("disabled")).toBe(false));
  fireEvent.click(within(fanart).getByRole("button", { name: "Test Connection" }));
  expect(await within(fanart).findByText("fanart connected.", { exact: false })).toBeTruthy();
  expect(within(fanart).getByRole("img", { name: "Fanart.tv connection verified" })).toBeTruthy();
  fireEvent.click(within(tvdb).getByRole("button", { name: "Test Connection" }));
  expect(await within(tvdb).findByText("TheTVDB rejected the credentials.", { exact: false })).toBeTruthy();
  expect(within(tvdb).queryByRole("img", { name: "TheTVDB connection verified" })).toBeNull();
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
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining("local catalog records, and temporary media-server images"));
  expect(api.deleteServer).not.toHaveBeenCalled();
  confirm.mockRestore();
  client.clear();
});

it("saves the shared TMDB token from Search Providers and clears the input", async () => {
  vi.mocked(creditsApi.saveToken).mockResolvedValue({ tmdb_configured: true, tvdb_configured: false });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<MemoryRouter initialEntries={["/settings?tab=sources"]}><QueryClientProvider client={client}><SettingsPage /></QueryClientProvider></MemoryRouter>);
  fireEvent.click(screen.getByRole("button", { name: "Configure TMDB" }));
  const input = await screen.findByLabelText("TMDB API Read Access Token or API key");
  expect(screen.queryByRole("button", { name: "Save token" })).toBeNull();
  fireEvent.change(input, { target: { value: " test-token " } });
  fireEvent.blur(input);
  await waitFor(() => expect(creditsApi.saveToken).toHaveBeenCalledWith("test-token"));
  await screen.findByText("Token saved");
  expect((input as HTMLInputElement).value).toBe("");
  expect(client.getQueryData(["credit-settings"])).toEqual({ tmdb_configured: true, tvdb_configured: false });
  vi.mocked(api.testArtworkProvider).mockResolvedValue({ ok: true, message: "TMDB API connection succeeded." });
  fireEvent.click(within(input.closest("form")!).getByRole("button", { name: "Test Connection" }));
  await screen.findByText("TMDB API connection succeeded.");
  expect(api.testArtworkProvider).toHaveBeenCalledWith({ provider: "tmdb" });
  client.clear();
});
