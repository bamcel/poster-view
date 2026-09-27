import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { creditsApi, type Credit, type SeriesCredits } from "../api/credits";
import CastCrewPanel from "./CastCrewPanel";
import CastPreferences from "./CastPreferences";
import { apiRequest } from "../api/client";
vi.mock("../api/client", () => ({ apiRequest: vi.fn() }));

vi.mock("../api/credits", () => ({ creditsApi: { get: vi.fn(), import: vi.fn(), remove: vi.fn(), language: vi.fn(), search: vi.fn(), settings: vi.fn(), saveToken: vi.fn() } }));
const credit = (name: string, language: string | null, category: "cast" | "crew" = "cast"): Credit => ({ person_id: name, name, image: null, person_url: null, character_id: null, character: category === "cast" ? "Hero" : null, character_image: null, category, role: category === "cast" ? "Voice" : "Director", language, dub_group: null, notes: null, order: 0 });
const data: SeriesCredits = { catalog_id: "series", original_language: "ja", sources: [{ provider: "anilist", external_id: "1", title: "Series", source_url: "https://anilist.co/anime/1", original_language: null, fetched_at: null, credits: [credit("Japanese actor", "ja"), credit("English actor", "en"), credit("French actor", "fr"), credit("Director name", null, "crew")] }] };
const clients: QueryClient[] = [];
beforeEach(() => { vi.mocked(apiRequest).mockImplementation(async (_path, init) => init?.body ? JSON.parse(init.body as string) : { show: true, hide_crew: false, mode: "both", language: "en" }); vi.mocked(creditsApi.get).mockResolvedValue(structuredClone(data)); vi.mocked(creditsApi.settings).mockResolvedValue({ tmdb_configured: false, tvdb_configured: true }); });
afterEach(() => { cleanup(); clients.forEach(c => c.clear()); clients.length = 0; vi.resetAllMocks(); localStorage.clear(); });
function mount(editing = false) { const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); clients.push(client); return render(<QueryClientProvider client={client}><CastPreferences />{editing && <CastCrewPanel serverId={1} item={{ id: "1", title: "Series", type: "show", seasons: [], members: [], external_ids: {} }} editing />}<CastCrewPanel serverId={1} item={{ id: "1", title: "Series", type: "show", seasons: [], members: [], external_ids: {} }} /></QueryClientProvider>); }
it("shows original plus English, supports another dub and displays crew", async () => {
  mount(); await screen.findByText("Japanese actor"); expect(screen.queryByText("English actor")).toBeNull(); fireEvent.click(screen.getByRole("tab", { name: "English Cast" })); expect(screen.getByText("English actor")).toBeTruthy(); expect(screen.queryByText("French actor")).toBeNull();
  fireEvent.change(screen.getByLabelText("Cast Language"), { target: { value: "fr" } });
  fireEvent.click(await screen.findByRole("tab", { name: "French Cast" }));
  await screen.findByText("French actor"); expect(screen.queryByText("English actor")).toBeNull();
  fireEvent.click(screen.getByRole("radio", { name: /Primary Cast Only/ }));
  await waitFor(() => expect(screen.queryByText("French actor")).toBeNull());
  expect(screen.getByText("Director name")).toBeTruthy();
  expect(screen.queryByRole("tab", { name: "Crew" })).toBeNull();
  expect(creditsApi.import).not.toHaveBeenCalled();
  expect(screen.queryByRole("button",{name:"Sources & matching"})).toBeNull();
  expect(screen.queryByRole("button",{name:/Find cast & crew/i})).toBeNull();
});
it("hides crew and the whole section without deleting saved credits", async () => {
  mount(); await screen.findByText("Japanese actor");
  await screen.findByText("Director name");
  fireEvent.click(screen.getByRole("switch", { name: "Hide Crew" }));
  await waitFor(() => expect(screen.queryByText("Director name")).toBeNull());expect(screen.getByText("Japanese actor")).toBeTruthy();
  fireEvent.click(screen.getByRole("switch", { name: "Show Cast & Crew" }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "Cast and crew" })).toBeNull());
  expect(screen.queryByRole("radio")).toBeNull();expect(creditsApi.remove).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("switch", { name: "Show Cast & Crew" }));await screen.findByText("Japanese actor");
});
it("keeps saved credits visible when provider refresh fails", async () => {
  vi.mocked(creditsApi.import).mockRejectedValue(new Error("Provider unavailable; saved credits kept."));
  mount(true); await screen.findByText("Japanese actor");
  fireEvent.click(screen.getByRole("button", { name: "Refresh AniList" }));
  await screen.findByRole("alert"); expect(screen.getByText("Japanese actor")).toBeTruthy();
});
it("requires an explicit candidate import and preserves the chosen provider ID", async () => {
  vi.mocked(creditsApi.search).mockResolvedValue([{ id: "999", title: "Matching series", year: 2001, image: null }]);
  vi.mocked(creditsApi.import).mockResolvedValue(data);
  mount(true); await screen.findByText("Japanese actor");
  fireEvent.change(screen.getByLabelText("Credits provider"), { target: { value: "mal" } });
  fireEvent.click(screen.getByRole("button", { name: "Search" })); await screen.findByText("Matching series");
  expect(creditsApi.import).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole("button", { name: "Import" }));
  await waitFor(() => expect(creditsApi.import).toHaveBeenCalledWith(1, "1", "mal", "999"));
});

it("groups characters across language performances and shows their saved biography", async () => {
  const value = structuredClone(data);
  value.sources[0].credits[0].character_bio = "A brave hero.";
  vi.mocked(creditsApi.get).mockResolvedValue(value);
  mount(); await screen.findByText("Japanese actor");
  fireEvent.click(screen.getByRole("tab", { name: "Characters" }));
  expect(screen.getAllByRole("button", { name: "Character info for Hero" })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Character info for Hero" }));
  expect(screen.getByRole("region", { name: "Hero character information" })).toBeTruthy();
  expect(screen.getByText("A brave hero.")).toBeTruthy();
  expect(screen.getByText(/English actor · English/)).toBeTruthy();
});

it.each(["show", "movie"] as const)("shows normal cast including untagged credits for live-action %s", async type => {
  vi.mocked(creditsApi.get).mockResolvedValue({ catalog_id: "1", original_language: "en", sources: [{ ...data.sources[0], provider: "tmdb", credits: [credit("Live actor", null), credit("Director", null, "crew")] }] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client);
  render(<QueryClientProvider client={client}><CastCrewPanel serverId={1} item={{ id: "1", title: "Live action", type, seasons: [], members: [], external_ids: { tmdb: "1" }, genres: ["Drama"] }} /></QueryClientProvider>);
  await screen.findByText("Live actor");
  expect(screen.queryByRole("tablist")).toBeNull();
  expect(screen.queryByRole("tab", { name: "English Cast" })).toBeNull();
  expect(screen.queryByRole("tab", { name: "Characters" })).toBeNull();
  
  expect(screen.getByText("Director", { selector: "p.font-semibold" })).toBeTruthy();
});
