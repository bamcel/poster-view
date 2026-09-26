import { cleanup,fireEvent,render,screen,waitFor } from "@testing-library/react";
import { QueryClient,QueryClientProvider } from "@tanstack/react-query";
import { afterEach,expect,it,vi } from "vitest";
import FindMissingMetadata,{MissingMetadataMenu} from "./FindMissingMetadata";
import { enrichmentApi } from "../api/videoEnrichment";
vi.mock("../api/videoEnrichment",()=>({enrichmentApi:{find:vi.fn()}}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
it("offers Find Missing Metadata from the accessible title menu",()=>{
  const find=vi.fn();render(<MissingMetadataMenu onFind={find}/>);
  fireEvent.click(screen.getByRole("button",{name:"Title options"}));fireEvent.click(screen.getByRole("menuitem",{name:"Find Missing Metadata"}));expect(find).toHaveBeenCalledOnce();
});
it("fetches once, displays results and opens metadata editing for unresolved matches",async()=>{
  vi.mocked(enrichmentApi.find).mockResolvedValue({filled:["genres","content_rating"],credits_added:5,issues:["Confirm the provider ID"],needs_matching:true});
  const edit=vi.fn();const client=new QueryClient({defaultOptions:{queries:{retry:false}}});const invalidate=vi.spyOn(client,"invalidateQueries");
  render(<QueryClientProvider client={client}><FindMissingMetadata serverId={1} itemId="movie" title="Film" onClose={()=>{}} onEdit={edit}/></QueryClientProvider>);
  await screen.findByText("2 fields filled · 5 credits added.");expect(enrichmentApi.find).toHaveBeenCalledTimes(1);expect(screen.getByText("Confirm the provider ID")).toBeTruthy();
  await waitFor(()=>expect(invalidate).toHaveBeenCalledWith({queryKey:["item-detail",1,"movie"]}));
  fireEvent.click(screen.getByRole("button",{name:"Edit Metadata"}));expect(edit).toHaveBeenCalledOnce();client.clear();
});
