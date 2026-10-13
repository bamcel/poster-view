import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import PluginsPage from "./PluginsPage";

vi.mock("../lib/artworkPlugin", () => ({ useArtworkPlugin: () => ({ data: { enabled: true } }) }));
vi.mock("./AniDBPlugin", () => ({ default: () => <button>AniDB</button> }));
vi.mock("./OmdbPlugin", () => ({ default: () => <button>The Open Movie Database</button> }));
vi.mock("../features/settings/ytdl/YtdlPlugin",()=>({default:()=> <button>YTDL</button>}));

afterEach(cleanup);

it("shows retained plugins without requesting the retired Google Books configuration", () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  try {
    render(<PluginsPage onClose={() => {}} onArtworkOpen={() => {}} />);
    expect(screen.queryByText("Google Books")).toBeNull();
    expect(screen.getByText("Artwork")).toBeTruthy();
    expect(screen.getByRole("button", { name: "AniDB" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "The Open Movie Database" })).toBeTruthy();
    expect(screen.getByRole("button",{name:"YTDL"})).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});
