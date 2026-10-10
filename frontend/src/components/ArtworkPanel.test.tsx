import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import type { ItemDetail, Library } from "../types";
import ArtworkPanel from "./ArtworkPanel";

vi.mock("../api/client", () => ({
  api: {
    artworkProviders: vi.fn(),
    getArtworkSettings: vi.fn(),
    getArtwork: vi.fn(),
    refreshArtworkItem: vi.fn(),
  },
}));
vi.mock("../lib/toast", () => ({ useToast: () => ({ push: vi.fn() }) }));
vi.mock("./PosterDBPanel", () => ({ default: () => <div>PosterDB panel</div> }));
vi.mock("./ArtworkBrowser", () => ({ default: () => <div>Artwork browser</div> }));
vi.mock("./ManualUpload", () => ({ default: () => <div>Manual upload</div> }));
vi.mock("./MangaDexPanel", () => ({ default: () => <div>MangaDex panel</div> }));
vi.mock("./VizPanel", () => ({ default: () => <div>VIZ panel</div> }));

const item: ItemDetail = {
  id: "series",
  title: "Example series",
  type: "folder",
  seasons: [],
  external_ids: {},
  members: [],
};

let client: QueryClient;

beforeEach(() => {
  localStorage.clear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(api.artworkProviders).mockResolvedValue([
    { name: "fanart", label: "Fanart.tv", configured: true, needs_key: true, enabled: true },
    { name: "anilist-manga", label: "AniList Manga", configured: true, needs_key: false, enabled: true },
    { name: "mangadex", label: "MangaDex", configured: true, needs_key: false, enabled: true },
  ]);
  vi.mocked(api.getArtworkSettings).mockResolvedValue({
    tmdb_configured: false,
    fanart_configured: true,
    tvdb_configured: false,
    comicvine_configured: false,
    default_provider: "posterdb",
    ereader_default_provider: "anilist-manga",
    enabled_providers: ["posterdb", "fanart", "anilist-manga", "mangadex"],
  });
});

afterEach(() => {
  cleanup();
  client.clear();
});

function show(libraryType: Library["type"]) {
  return render(
    <QueryClientProvider client={client}>
      <ArtworkPanel serverId={1} item={item} libraryType={libraryType} />
    </QueryClientProvider>,
  );
}

describe("ArtworkPanel cross-library databases", () => {
  it.each([["movie", "MyAnimeList"], ["book", "MyAnimeList Manga"]] as const)("shows the matching MAL artwork source for %s", async (type, label) => {
    vi.mocked(api.artworkProviders).mockResolvedValue([
      {name:"myanimelist",label:"MyAnimeList",configured:true,needs_key:true,enabled:true},
      {name:"myanimelist-manga",label:"MyAnimeList Manga",configured:true,needs_key:true,enabled:true},
    ]);
    show(type);
    fireEvent.click(await screen.findByRole("button",{name:label}));
    expect(screen.getByText("Artwork browser")).toBeTruthy();
  });
  it.each([
    ["book", "AniList Manga", "ThePosterDB"],
    ["movie", "ThePosterDB", "AniList Manga"],
  ] as const)("expands the alternate databases for %s libraries", async (libraryType, primary, alternate) => {
    show(libraryType);

    expect(await screen.findByRole("button", { name: primary })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Manual" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: alternate })).toBeNull();

    const toggle = screen.getByRole("button", { name: "Show more artwork databases" });
    expect(toggle.textContent).toContain("Show More");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);

    expect(screen.getByRole("button", { name: alternate })).toBeTruthy();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("places artwork removal between Manual and Show More", async () => {
    show("book");

    const manual = await screen.findByRole("button", { name: "Manual" });
    const remove = screen.getByRole("button", { name: "Remove" });
    const showMore = await screen.findByRole("button", { name: "Show more artwork databases" });
    expect(manual.compareDocumentPosition(remove) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(remove.compareDocumentPosition(showMore) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(remove);
    expect(screen.getByRole("heading", { name: "Remove artwork" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove All" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Series cover/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Series backdrop/ })).toBeTruthy();
  });
});

it("switches matching artwork tool tabs and underlines the selected tab",()=>{
 render(<QueryClientProvider client={client}><ArtworkPanel serverId={1} item={item}/></QueryClientProvider>);
 const artwork=screen.getByRole("tab",{name:"Artwork"});const editor=screen.getByRole("tab",{name:"PosterEdit"});
 expect(artwork.getAttribute("aria-selected")).toBe("true");expect(artwork.className).toContain("border-accent");
 fireEvent.click(editor);
 expect(editor.getAttribute("aria-selected")).toBe("true");expect(editor.className).toContain("border-accent");
 expect(artwork.getAttribute("aria-selected")).toBe("false");expect(editor.querySelector("svg")).toBeTruthy();
 expect(screen.getByText(/Add a poster and a series logo/)).toBeTruthy();
});
