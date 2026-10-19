import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import PluginsPage,{ArtworkPopup} from "./PluginsPage";
import {AuthSessionContext} from "../lib/authContext";
import type {AuthSession} from "../api/client";

vi.mock("../lib/artworkPlugin", () => ({ useArtworkPlugin: () => ({ data: { enabled: true } }) }));
vi.mock("./AniDBPlugin", () => ({ default: () => <button>AniDB</button> }));
vi.mock("./OmdbPlugin", () => ({ default: () => <button>The Open Movie Database</button> }));
vi.mock("../features/settings/ytdl/YtdlPlugin",()=>({default:()=> <button>YTDL</button>}));
vi.mock("../features/virtual-tv/VirtualTvPlugin",()=>({default:()=> <button>Virtual TV</button>}));
vi.mock("../features/pairwise/PairwisePlugin",()=>({default:()=> <button>PairWise Ranking</button>}));

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
    expect(screen.getByRole("button",{name:"Virtual TV"})).toBeTruthy();
    expect(screen.getByRole("button",{name:"PairWise Ranking"})).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

it("hides plugin management and configuration from regular users",()=>{
 const viewer:AuthSession={authenticated:true,user:{id:"viewer",username:"viewer",display_name:"Viewer",role:"user",enabled:true,revision:1,created_at:"",permissions:{all_libraries:true,library_ids:[],max_movie_rating:null,max_tv_rating:null,allow_unrated:true}}};
 const {container}=render(<AuthSessionContext.Provider value={viewer}><PluginsPage onClose={()=>{}} onArtworkOpen={()=>{}} artworkOpen/><ArtworkPopup onClose={()=>{}}/></AuthSessionContext.Provider>);
 expect(container.textContent).toBe("");
 expect(screen.queryByRole("dialog",{name:"Artwork configuration"})).toBeNull();
});
