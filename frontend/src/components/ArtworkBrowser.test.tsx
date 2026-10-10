import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "../api/client";
import ArtworkBrowser from "./ArtworkBrowser";
vi.mock("../api/client", () => ({api:{getArtwork:vi.fn(),applyPoster:vi.fn()}}));
vi.mock("../lib/toast", () => ({useToast:()=>({push:vi.fn()})}));
vi.mock("./CustomTargetButton", () => ({default:()=>null}));
afterEach(cleanup);

it("groups animated posters, backgrounds, and provider animation results together", async()=>{
 const base={provider:"fanart",kind:"show" as const,thumb_url:"https://assets.fanart.tv/thumb.jpg",applyable:true};
 vi.mocked(api.getArtwork).mockResolvedValue({provider:"fanart",items:[
 {...base,id:"still",type:"poster",title:"Static cover",download_url:"https://assets.fanart.tv/still.jpg"},
 {...base,id:"gif",type:"poster",title:"GIF cover",download_url:"https://assets.fanart.tv/cover.GIF?token=test"},
 {...base,id:"video",type:"background",title:"Moving background",download_url:"https://assets.fanart.tv/background.webm"},
 {...base,id:"animated",type:"animated",title:"Provider animation",download_url:"https://assets.fanart.tv/original"},
 ]});
 vi.mocked(api.applyPoster).mockResolvedValue({ok:true,message:"Applied"});
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 render(<QueryClientProvider client={client}><ArtworkBrowser provider="fanart" serverId={0} item={{id:"native:lib:item",title:"Example",type:"show",seasons:[],external_ids:{},members:[]}}/></QueryClientProvider>);
 fireEvent.click(await screen.findByRole("button",{name:/^Animated\s*3$/}));
 expect(screen.getByAltText("GIF cover")).toBeTruthy();expect(screen.getByAltText("Moving background")).toBeTruthy();expect(screen.getByAltText("Provider animation")).toBeTruthy();expect(screen.queryByAltText("Static cover")).toBeNull();
 fireEvent.click(screen.getAllByRole("button",{name:"Animated Poster"})[0]);
 await waitFor(()=>expect(api.applyPoster).toHaveBeenCalledWith(expect.objectContaining({target:"poster",download_url:"https://assets.fanart.tv/cover.GIF?token=test"})));
 fireEvent.click(screen.getAllByRole("button",{name:"Animated Background"})[1]);
 await waitFor(()=>expect(api.applyPoster).toHaveBeenCalledWith(expect.objectContaining({target:"background",download_url:"https://assets.fanart.tv/background.webm"})));
});
