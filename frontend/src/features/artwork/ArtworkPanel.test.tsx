import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import type { ItemDetail, Library } from "../../types";
import ArtworkPanel from "./ArtworkPanel";

vi.mock("../../api/client", () => ({
  api: {
    artworkProviders: vi.fn(),
    getArtworkSettings: vi.fn(),
    getArtwork: vi.fn(),
    refreshArtworkItem: vi.fn(),
  },
}));
vi.mock("../../lib/toast", () => ({ useToast: () => ({ push: vi.fn() }) }));
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
    { name: "tvdb", label: "TheTVDB", configured: true, needs_key: true, enabled: true },
    { name: "mediux", label: "MediUX", configured: true, needs_key: false, enabled: true },
    { name: "anilist", label: "AniList", configured: true, needs_key: false, enabled: true },
    { name: "myanimelist", label: "MyAnimeList", configured: true, needs_key: true, enabled: true },
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

function show(libraryType: Library["type"] | "anime") {
  return render(
    <QueryClientProvider client={client}>
      <ArtworkPanel serverId={1} item={item} libraryType={libraryType} />
    </QueryClientProvider>,
  );
}

describe("ArtworkPanel cross-library databases", () => {
  it.each([["anime", "MyAnimeList"], ["book", "MyAnimeList Manga"]] as const)("shows the matching MAL artwork source for %s", async (type, label) => {
    vi.mocked(api.artworkProviders).mockResolvedValue([
      {name:"myanimelist",label:"MyAnimeList",configured:true,needs_key:true,enabled:true},
      {name:"myanimelist-manga",label:"MyAnimeList Manga",configured:true,needs_key:true,enabled:true},
    ]);
    show(type);
    fireEvent.click(await screen.findByRole("button",{name:label}));
    expect(screen.getByText("Artwork browser")).toBeTruthy();
  });
  it.each(["movie", "show", "anime"] as const)("hides book databases in %s libraries", async (type) => {
    show(type);
    await screen.findByRole("button", {name: "ThePosterDB"});
    expect(screen.queryByRole("button", {name:"Show more artwork databases"})).toBeNull();
    expect(screen.queryByRole("button", {name: "AniList Manga"})).toBeNull();
    if(type !== "anime") {
      expect(screen.queryByRole("button", {name:"AniList"})).toBeNull();
      expect(screen.queryByRole("button", {name:"MyAnimeList"})).toBeNull();
    }
    for(const name of ["ThePosterDB", "TheTVDB", "Fanart.tv", "MediUX", "Manual"]){
      expect(screen.getByRole("button", {name})).toBeTruthy();
    }
    fireEvent.click(screen.getByRole("switch", {name:"Compact artwork sources"}));
    const options=screen.getAllByRole("option").map(option=>option.textContent);
    expect(options).not.toContain("AniList Manga");
  });
  it("offers all other enabled databases through Show More only for books", async () => {
    show("book");
    await screen.findByRole("button", {name:"AniList Manga"});
    expect(screen.queryByRole("button", {name:"ThePosterDB"})).toBeNull();
    const toggle=screen.getByRole("button", {name:"Show more artwork databases"});
    fireEvent.click(toggle);
    for(const name of ["ThePosterDB", "TheTVDB", "Fanart.tv", "MediUX", "AniList", "MyAnimeList"]){
      expect(screen.getByRole("button", {name})).toBeTruthy();
    }
    fireEvent.click(screen.getByRole("button", {name:"Fanart.tv"}));
    expect(screen.getByText("Artwork browser")).toBeTruthy();
    fireEvent.click(screen.getByRole("switch", {name:"Compact artwork sources"}));
    expect(screen.getByRole("option", {name:"ThePosterDB"})).toBeTruthy();
  });
  it("keeps artwork removal after Manual", async () => {
    show("book");

    await screen.findByRole("button", { name: "AniList Manga" });
    const manual = screen.getByRole("button", { name: "Manual" });
    const remove = screen.getByRole("button", { name: "Remove" });

    expect(manual.compareDocumentPosition(remove) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();


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

it("offers collection artwork without unsupported editor tools or server refresh",async()=>{
 render(<QueryClientProvider client={client}><ArtworkPanel serverId={0} item={{...item,id:"collection:saga",type:"collection"}}/></QueryClientProvider>);
 fireEvent.click(await screen.findByRole("button",{name:"ThePosterDB"}));
 expect(screen.queryByRole("tab",{name:"PosterEdit"})).toBeNull();
 expect(screen.queryByRole("tab",{name:"BackdropEdit"})).toBeNull();
 fireEvent.click(screen.getByRole("button",{name:"Refresh ThePosterDB cache"}));
 expect(api.refreshArtworkItem).not.toHaveBeenCalled();
});

it("restricts channel artwork to manual sources without requesting providers",async()=>{
 vi.mocked(api.artworkProviders).mockClear();vi.mocked(api.getArtworkSettings).mockClear();
 render(<QueryClientProvider client={client}><ArtworkPanel serverId={0} item={item} manualOnly/></QueryClientProvider>);
 expect(await screen.findByText('Manual upload')).toBeTruthy();
 expect(screen.queryByRole('button',{name:'ThePosterDB'})).toBeNull();
 expect(screen.queryByRole('tab',{name:'PosterEdit'})).toBeNull();
 expect(api.artworkProviders).not.toHaveBeenCalled();expect(api.getArtworkSettings).not.toHaveBeenCalled();
});
