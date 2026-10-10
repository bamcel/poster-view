import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SettingsPage from "./SettingsPage";
import { api } from "../api/client";
import type { AppearanceSettings } from "../types";

vi.mock("../components/AppearancePreview", () => ({ default: ({ onClose }: { onClose: () => void }) => <section aria-label="Live Dashboard preview"><button onClick={onClose}>Close split view</button></section> }));

vi.mock("../api/client", () => ({
  apiRequest:vi.fn(async(url:string)=>{if(url.startsWith("/plugins/"))return {enabled:true,pinned:false,poster_edit:true,backdrop_edit:true};throw new Error("Not configured");}),
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
  HTMLDialogElement.prototype.showModal = function(){this.setAttribute("open", "");};
  localStorage.clear();
  sessionStorage.clear();
  vi.mocked(api.listServers).mockResolvedValue([]);
  const appearance = { configured: true, backdrops_enabled: false, panel_solidity: 40, panel_blur: 12, panel_overlay: 0, backdrop_overlay: 72, pill_background_opacity: 5, theme_name: "Everforest", custom_themes_json: "[]" };
  vi.mocked(api.appearanceSettings).mockResolvedValue(appearance);
  vi.mocked(api.saveAppearanceSettings).mockImplementation(async (settings) => settings);
  vi.mocked(api.posterdbStatus).mockResolvedValue({ configured: true, logged_in: false, email: "test@example.test", message: "" });
  vi.mocked(api.getArtworkSettings).mockResolvedValue({
    tmdb_configured: false,
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
  fireEvent.click(screen.getByRole("button", { name: "Split View" }));
  expect(screen.getByRole("region", { name: "Live Dashboard preview" })).toBeTruthy();
  const divider = screen.getByRole("separator");
  fireEvent.keyDown(divider, { key: "ArrowRight" });
  expect(divider.getAttribute("aria-valuenow")).toBe("42");
  expect(screen.getByRole("slider", { name: "Panel Blur" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Close split view" }));
  expect(screen.queryByRole("region", { name: "Live Dashboard preview" })).toBeNull();
  expect(screen.getByRole("button", { name: "Split View" }).getAttribute("aria-pressed")).toBe("false");
  Object.defineProperty(window, "innerWidth", { value: originalWidth, configurable: true });
  client.clear();
});

it("restores open and closed split preview state after leaving Appearance", () => {
  const originalWidth = window.innerWidth;
  Object.defineProperty(window, "innerWidth", { value: 1600, configurable: true });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const mount = () => render(<MemoryRouter initialEntries={["/settings?tab=appearance"]}><QueryClientProvider client={client}><SettingsPage /></QueryClientProvider></MemoryRouter>);
  try {
    const first = mount();
    fireEvent.click(screen.getByRole("button", { name: "Split View" }));
    expect(screen.getByRole("region", { name: "Live Dashboard preview" })).toBeTruthy();
    first.unmount();
    const second = mount();
    expect(screen.getByRole("button", { name: "Split View" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Close split view" }));
    second.unmount();
    mount();
    expect(screen.queryByRole("region", { name: "Live Dashboard preview" })).toBeNull();
    expect(screen.getByRole("button", { name: "Split View" }).getAttribute("aria-pressed")).toBe("false");
  } finally {
    Object.defineProperty(window, "innerWidth", { value: originalWidth, configurable: true });
    client.clear();
  }
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
    <MemoryRouter initialEntries={["/settings/appearance"]}>
      <QueryClientProvider client={client}>
        <SettingsPage />
      </QueryClientProvider>
    </MemoryRouter>,
  );

  fireEvent.click(screen.getByLabelText("Toggle JSON Editor"));
  const themeEditor = screen.getByLabelText("JSON Editor") as HTMLTextAreaElement;
  expect(themeEditor.value).toContain('"name": "Everforest"');
  expect(themeEditor.style.fontSize).toBe("0.5625rem");
  expect(themeEditor.style.lineHeight).toBe("0.75rem");

  fireEvent.click(screen.getByLabelText("Choose Accent color"));
  expect(screen.getByLabelText("Accent HEX color")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Accent HEX color"), { target: { value: "#ff3366" } });
  fireEvent.click(screen.getByRole("button", {name:"Done"}));
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

  expect(screen.getByRole("heading", {name:"Appearance"})).toBeTruthy();
  const themeJsonToggle = screen.getByLabelText("Toggle JSON Editor");
  expect(themeJsonToggle.className).toContain("h-10");
  expect(themeJsonToggle.closest("details")?.open).toBe(false);
  fireEvent.click(themeJsonToggle);
  expect(themeJsonToggle.closest("details")?.open).toBe(true);
  expect(screen.getByLabelText("JSON Editor")).toBeTruthy();
  client.clear();
});

it("persists and resets Dashboard appearance controls", () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<MemoryRouter initialEntries={["/settings/appearance"]}><QueryClientProvider client={client}><SettingsPage /></QueryClientProvider></MemoryRouter>);

  expect(screen.getByRole("heading", { name: "Layout & Backgrounds" })).toBeTruthy();
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

it("groups existing providers without disable controls or new metadata providers", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter initialEntries={["/settings/sources"]}>
      <QueryClientProvider client={client}>
        <SettingsPage />
      </QueryClientProvider>
    </MemoryRouter>,
  );

  expect(screen.queryByText("Show Providers")).toBeNull();
  expect(screen.queryByRole("group", {name:"eReader providers"})).toBeNull();
  expect(screen.queryByRole("combobox", {name:"Default provider"})).toBeNull();
  for (const name of ["AniList", "AniList Manga", "MediUX", "MangaDex", "VIZ"]) {
    expect(screen.getByRole("button", { name: `Configure ${name}` })).toBeTruthy();
  }
  expect(screen.getByRole("button", { name: "Configure TMDB" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Configure AniDB" })).toBeTruthy();
  expect(screen.queryByText("Show Providers")).toBeNull();
  client.clear();
});


it("keeps each provider test result inside its own card", async () => {
  vi.mocked(api.getArtworkSettings).mockResolvedValue({
    tmdb_configured: false, fanart_configured: true, tvdb_configured: true, comicvine_configured: true, default_provider: "fanart", ereader_default_provider: "comicvine", enabled_providers: ["fanart", "tvdb", "comicvine"] });
  vi.mocked(api.testArtworkProvider).mockImplementation(async ({ provider }) => ({ ok: provider !== "tvdb", message: provider === "tvdb" ? "TheTVDB rejected the credentials." : `${provider} connected.` }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<MemoryRouter initialEntries={["/settings?tab=sources"]}><QueryClientProvider client={client}><SettingsPage /></QueryClientProvider></MemoryRouter>);
  const fanart = await screen.findByRole("region", { name: "Fanart.tv connection" });
  const tvdb = screen.getByRole("region", { name: "TheTVDB connection" });
  expect(within(fanart).queryByRole("img", { name: "Fanart.tv connection verified" })).toBeNull();
  fireEvent.click(within(fanart).getByRole("button", { name: "Configure Fanart.tv" }));
  fireEvent.click(within(tvdb).getByRole("button", { name: "Configure TheTVDB" }));
  await waitFor(() => expect(within(fanart).getByRole("button", { name: "Test Connection" }).hasAttribute("disabled")).toBe(false));
  fireEvent.click(within(fanart).getByRole("button", { name: "Test Connection" }));
  expect(await within(fanart).findByText("fanart connected.", { exact: false })).toBeTruthy();
  expect(within(fanart).getByRole("img", { name: "Fanart.tv connection verified" })).toBeTruthy();
  fireEvent.click(within(tvdb).getByRole("button", { name: "Test Connection" }));
  expect(await within(tvdb).findByText("TheTVDB rejected the credentials.", { exact: false })).toBeTruthy();
  expect(within(fanart).queryByText("TheTVDB rejected the credentials.", { exact: false })).toBeNull();
  expect(within(fanart).getByText("fanart connected.", { exact: false })).toBeTruthy();
  client.clear();
});

it("saves TMDB credentials on blur and tests the saved connection", async () => {
  const settings = await api.getArtworkSettings();
  vi.mocked(api.setArtworkSettings).mockResolvedValue({ ...settings, tmdb_configured: true });
  vi.mocked(api.testArtworkProvider).mockResolvedValue({ ok: true, message: "TMDB API connection succeeded." });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<MemoryRouter initialEntries={["/settings/sources"]}><QueryClientProvider client={client}><SettingsPage /></QueryClientProvider></MemoryRouter>);
  fireEvent.click(screen.getByRole("button", { name: "Configure TMDB" }));
  const region = within(screen.getByRole("region", { name: "TMDB connection" }));
  const input = region.getByLabelText("TMDB API Read Access Token or API key");
  fireEvent.change(input, { target: { value: "  example.token  " } });
  fireEvent.blur(input);
  await waitFor(() => expect(api.setArtworkSettings).toHaveBeenCalledWith({ tmdb_access_token: "example.token" }));
  await waitFor(() => expect((input as HTMLInputElement).value).toBe(""));
  fireEvent.click(region.getByRole("button", { name: "Test Connection" }));
  await waitFor(() => expect(api.testArtworkProvider).toHaveBeenCalledWith({ provider: "tmdb" }));
  await waitFor(() => expect(region.getByRole("img", { name: "TMDB connection verified" })).toBeTruthy());
  fireEvent.blur(input);
  expect(api.setArtworkSettings).toHaveBeenCalledTimes(1);
  client.clear();
});


it("opens Artwork plugin settings with unpinned defaults and shared provider access",async()=>{
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 render(<MemoryRouter initialEntries={["/settings/plugins"]}><QueryClientProvider client={client}><SettingsPage/></QueryClientProvider></MemoryRouter>);
 fireEvent.click(await screen.findByRole("button",{name:/^Artwork Browse/}));
 expect((await screen.findByRole("switch",{name:"Enable Artwork"}) as HTMLInputElement).checked).toBe(true);
 expect((screen.getByRole("switch",{name:"Pin to Settings"}) as HTMLInputElement).checked).toBe(false);
 expect((screen.getByRole("switch",{name:"Enable PosterEdit"}) as HTMLInputElement).checked).toBe(true);
 expect(screen.getByRole("link",{name:"Manage Search Providers"}).getAttribute("href")).toBe("/settings/sources");
 client.clear();
});

it("hides Server Connect even when saved settings enable it",async()=>{
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 render(<MemoryRouter initialEntries={["/settings/plugins"]}><QueryClientProvider client={client}><SettingsPage/></QueryClientProvider></MemoryRouter>);
 await screen.findByRole("button",{name:/Artwork Browse/});
 expect(screen.queryByRole("button",{name:/Server Connect/})).toBeNull();
 expect(screen.queryByRole("button",{name:"Add server"})).toBeNull();
});
