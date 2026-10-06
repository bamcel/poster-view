import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "../api/client";
import ArtworkBrowser from "./ArtworkBrowser";
vi.mock("../api/client", () => ({api:{getArtwork:vi.fn(),applyPoster:vi.fn()}}));
vi.mock("../lib/toast", () => ({useToast:()=>({push:vi.fn()})}));
vi.mock("./CustomTargetButton", () => ({default:()=>null}));
afterEach(cleanup);
it("prefills DeviantArt from the title and pages within the chosen tag", async () => {
 vi.mocked(api.getArtwork).mockResolvedValue({provider:"deviantart",items:[{id:"art",provider:"deviantart",type:"poster",kind:"show",title:"Art — artist",thumb_url:"https://images.wixmp.com/a.jpg",download_url:"https://images.wixmp.com/a.jpg",applyable:true,source_url:"https://www.deviantart.com/artist/art/a"}]});
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 render(<QueryClientProvider client={client}><ArtworkBrowser provider="deviantart" serverId={0} item={{id:"native:lib:item",title:"Akame ga Kill!",type:"show",seasons:[],external_ids:{},members:[]}}/></QueryClientProvider>);
 await waitFor(()=>expect(api.getArtwork).toHaveBeenLastCalledWith("deviantart",0,"native:lib:item","Akame ga Kill!|0"));
 await screen.findByText("Art — artist");
 fireEvent.click(screen.getByRole("button",{name:"Next"}));
 await waitFor(()=>expect(api.getArtwork).toHaveBeenLastCalledWith("deviantart",0,"native:lib:item","Akame ga Kill!|50"));
 const input=screen.getByRole("textbox");
 fireEvent.change(input,{target:{value:"night_raid"}});
 fireEvent.submit(input.closest("form")!);
 await waitFor(()=>expect(api.getArtwork).toHaveBeenLastCalledWith("deviantart",0,"native:lib:item","night_raid|0"));
 expect(screen.getByText("Page 1")).toBeTruthy();
});

it("groups animated posters, backgrounds, and provider animation results together", async()=>{
 const base={provider:"deviantart",kind:"show" as const,thumb_url:"https://images.wixmp.com/thumb.jpg",applyable:true};
 vi.mocked(api.getArtwork).mockResolvedValue({provider:"deviantart",items:[
 {...base,id:"still",type:"poster",title:"Static cover",download_url:"https://images.wixmp.com/still.jpg"},
 {...base,id:"gif",type:"poster",title:"GIF cover",download_url:"https://images.wixmp.com/cover.GIF?token=test"},
 {...base,id:"video",type:"background",title:"Moving background",download_url:"https://images.wixmp.com/background.webm"},
 {...base,id:"animated",type:"animated",title:"Provider animation",download_url:"https://images.wixmp.com/original"},
 ]});
 vi.mocked(api.applyPoster).mockResolvedValue({ok:true,message:"Applied"});
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 render(<QueryClientProvider client={client}><ArtworkBrowser provider="deviantart" serverId={0} item={{id:"native:lib:item",title:"Example",type:"show",seasons:[],external_ids:{},members:[]}}/></QueryClientProvider>);
 fireEvent.click(await screen.findByRole("button",{name:/^Animated\s*3$/}));
 expect(screen.getByText("GIF cover")).toBeTruthy();expect(screen.getByText("Moving background")).toBeTruthy();expect(screen.getByText("Provider animation")).toBeTruthy();expect(screen.queryByText("Static cover")).toBeNull();
 fireEvent.click(screen.getAllByRole("button",{name:"Animated Poster"})[0]);
 await waitFor(()=>expect(api.applyPoster).toHaveBeenCalledWith(expect.objectContaining({target:"poster",download_url:"https://images.wixmp.com/cover.GIF?token=test"})));
 fireEvent.click(screen.getAllByRole("button",{name:"Animated Background"})[1]);
 await waitFor(()=>expect(api.applyPoster).toHaveBeenCalledWith(expect.objectContaining({target:"background",download_url:"https://images.wixmp.com/background.webm"})));
});
