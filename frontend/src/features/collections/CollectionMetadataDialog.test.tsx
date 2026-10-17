import {cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import CollectionMetadataDialog from "./CollectionMetadataDialog";
import {collectionsApi,type Collection,type MetadataCandidate} from "./client";
const publish=vi.hoisted(()=>vi.fn());
vi.mock("../activity/ActivityContext",()=>({useActivity:()=>({publish})}));
const collection:Collection={id:"saga",title:"Local Saga",overview:"Local description",ordering:"custom",revision:4,created_at:"",updated_at:"",members:[],metadata:{provider:"tmdb",provider_id:"42",poster_url:"",backdrop_url:"",locks:["title"]}};
const candidate:MetadataCandidate={provider:"tmdb",provider_id:"42",title:"Provider Saga",overview:"Provider description",poster_url:"https://example.com/poster.jpg",backdrop_url:"https://example.com/backdrop.jpg"};
const onClose=vi.fn();
function mount(mode:"identify"|"refresh"|"locks"="identify"){return render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><CollectionMetadataDialog collection={collection} mode={mode} onClose={onClose}/></QueryClientProvider>);}
beforeEach(()=>{vi.spyOn(collectionsApi,"searchMetadata").mockResolvedValue([candidate]);vi.spyOn(collectionsApi,"previewMetadata").mockResolvedValue({metadata:candidate,matches:[],unmatched:2});vi.spyOn(collectionsApi,"applyMetadata").mockResolvedValue(collection);vi.spyOn(collectionsApi,"saveMetadataLocks").mockResolvedValue(collection);publish.mockClear();onClose.mockClear();});
afterEach(()=>{cleanup();vi.restoreAllMocks();});
it("previews identification and applies locks without adding matches by default",async()=>{
 mount();fireEvent.click(screen.getByRole("button",{name:"Search"}));
 fireEvent.click(await screen.findByRole("button",{name:/Provider Saga/}));
 await screen.findByText("0 local matches · 2 unmatched provider titles");
 expect(screen.getByRole("checkbox",{name:"Add matching local movies and series"})).toHaveProperty("checked",false);
 fireEvent.click(screen.getByRole("checkbox",{name:"poster"}));
 fireEvent.click(screen.getByRole("button",{name:"Apply metadata"}));
 await waitFor(()=>expect(onClose).toHaveBeenCalled());
 expect(collectionsApi.applyMetadata).toHaveBeenCalledWith("saga",{revision:4,provider:"tmdb",provider_id:"42",locks:["title","poster"],add_members:false});
 expect(publish).not.toHaveBeenCalled();
});
it("refreshes the linked identity and adds local matches only when opted in",async()=>{
 mount("refresh");await screen.findByText("Provider description");
 expect(collectionsApi.searchMetadata).not.toHaveBeenCalled();expect(collectionsApi.previewMetadata).toHaveBeenCalledWith("saga",{provider:"tmdb",provider_id:"42"});
 fireEvent.click(screen.getByRole("checkbox",{name:"Add matching local movies and series"}));fireEvent.click(screen.getByRole("button",{name:"Apply metadata"}));
 await waitFor(()=>expect(collectionsApi.applyMetadata).toHaveBeenCalledWith("saga",expect.objectContaining({add_members:true})));
});
it("saves field locks independently without provider requests",async()=>{
 mount("locks");fireEvent.click(screen.getByRole("checkbox",{name:"title"}));fireEvent.click(screen.getByRole("checkbox",{name:"backdrop"}));fireEvent.click(screen.getByRole("button",{name:"Save locks"}));
 await waitFor(()=>expect(collectionsApi.saveMetadataLocks).toHaveBeenCalledWith("saga",{revision:4,locks:["backdrop"]}));expect(collectionsApi.previewMetadata).not.toHaveBeenCalled();expect(collectionsApi.applyMetadata).not.toHaveBeenCalled();
 await waitFor(()=>expect(publish).toHaveBeenLastCalledWith("collection-metadata:saga",[expect.objectContaining({title:"Local Saga field locks",state:"completed",detail:"Field locks saved"})]));
});
it("lets an admin review matched local titles before opting in",async()=>{
 vi.mocked(collectionsApi.previewMetadata).mockResolvedValue({metadata:candidate,matches:[{library_id:"movies",library_name:"Movies",item_id:"film",entry:{id:"film",title:"Local matching film"} as Collection["members"][number]["entry"]}],unmatched:1});
 mount("refresh");
 await screen.findByText("Review matched library titles");
 fireEvent.click(screen.getByText("Review matched library titles"));
 expect(screen.getByText("Local matching film")).toBeTruthy();
 expect(screen.getByRole("checkbox",{name:"Add matching local movies and series"})).toHaveProperty("checked",false);
});
it("explains TVDB exact lookup and handles no results",async()=>{
 vi.mocked(collectionsApi.searchMetadata).mockResolvedValue([]);mount();fireEvent.change(screen.getByRole("combobox",{name:"Provider"}),{target:{value:"tvdb"}});
 expect(screen.getByLabelText("List name, slug, or ID")).toBeTruthy();fireEvent.click(screen.getByRole("button",{name:"Search"}));
 expect(await screen.findByText("No matching collections found.")).toBeTruthy();expect(collectionsApi.searchMetadata).toHaveBeenCalledWith("tvdb","Local Saga");
});
it("keeps safe inline failure feedback without duplicating the server-owned apply activity",async()=>{
 vi.mocked(collectionsApi.applyMetadata).mockRejectedValue(new Error("private/path"));mount("refresh");await screen.findByText("Provider description");fireEvent.click(screen.getByRole("button",{name:"Apply metadata"}));
 expect(await screen.findByRole("alert")).toHaveProperty("textContent","Could not save collection metadata. Refresh the collection and try again.");expect(onClose).not.toHaveBeenCalled();expect(publish).not.toHaveBeenCalled();
});
it("keeps local failure status for synchronous field-lock updates",async()=>{
 vi.mocked(collectionsApi.saveMetadataLocks).mockRejectedValue(new Error("private/path"));mount("locks");fireEvent.click(screen.getByRole("button",{name:"Save locks"}));
 await screen.findByRole("alert");expect(onClose).not.toHaveBeenCalled();expect(publish).toHaveBeenLastCalledWith("collection-metadata:saga",[expect.objectContaining({state:"failed",title:"Local Saga field locks"})]);
});
