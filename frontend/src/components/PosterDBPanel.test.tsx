import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {cleanup, fireEvent, render, screen, waitFor} from "@testing-library/react";
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import {api} from "../api/client";
import type {ItemDetail} from "../types";
import PosterDBBody from "./PosterDBPanel";

vi.mock("../api/client", () => ({api:{posterdbStatus:vi.fn(),posterdbSearch:vi.fn(),posterdbSearchPreview:vi.fn(),posterdbSet:vi.fn(),posterdbVerify:vi.fn()}}));
vi.mock("../lib/toast", () => ({useToast:()=>({push:vi.fn()})}));
const item: ItemDetail = {id:"native:library:movie",title:"1917",type:"movie",seasons:[],members:[],external_ids:{}};
let client: QueryClient;
beforeEach(()=>{
 client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 vi.mocked(api.posterdbStatus).mockResolvedValue({configured:true,logged_in:true,email:"",message:""});
 vi.mocked(api.posterdbSearch).mockResolvedValue({term:"1917",categories:[]});
 vi.mocked(api.posterdbSearchPreview).mockResolvedValue(null);
});
afterEach(()=>{cleanup();client.clear();vi.clearAllMocks();});
function panel(title=item, prefill?:{term:string;nonce:number}) {return <QueryClientProvider client={client}><PosterDBBody serverId={0} item={title} prefill={prefill}/></QueryClientProvider>;}
it("automatically searches the title, including numeric movie names",async()=>{
 render(panel());
 await waitFor(()=>expect(api.posterdbSearch).toHaveBeenCalledWith(0,"1917"));
 expect((screen.getByLabelText("Search ThePosterDB by title or poster/set URL") as HTMLInputElement).value).toBe("1917");
 expect(api.posterdbSearch).toHaveBeenCalledTimes(1);
});
it("searches the new title on item changes and respects explicit search terms",async()=>{
 const view=render(panel());
 await waitFor(()=>expect(api.posterdbSearch).toHaveBeenCalledWith(0,"1917"));
 view.rerender(panel({...item,id:"native:library:series",title:"Example Series"}));
 await waitFor(()=>expect(api.posterdbSearch).toHaveBeenCalledWith(0,"Example Series"));
 view.rerender(panel(item,{term:"Custom title",nonce:1}));
 await waitFor(()=>expect(api.posterdbSearch).toHaveBeenCalledWith(0,"Custom title"));
});
it("does not search without configured credentials",async()=>{
 vi.mocked(api.posterdbStatus).mockResolvedValue({configured:false,logged_in:false,email:"",message:""});
 render(panel());
 await screen.findByText(/Add your ThePosterDB email/);
 expect(api.posterdbSearch).not.toHaveBeenCalled();
});

it("restores the panel search scroll position after returning from a title",async()=>{
 vi.mocked(api.posterdbSearch).mockResolvedValue({term:"1917",categories:[{name:"Movies",count:1,results:[{title:"1917 result",url:"https://theposterdb.com/posters/123",media_id:"123"}]}]});
 vi.mocked(api.posterdbVerify).mockResolvedValue({"123":1});
 vi.mocked(api.posterdbSet).mockResolvedValue({set_url:"https://theposterdb.com/posters/123",title:"Title posters",posters:[]});
 render(<div data-testid="scroller" style={{overflowY:"auto"}}>{panel()}</div>);
 const result=await screen.findByRole("button",{name:/1917 result/});
 const scroller=screen.getByTestId("scroller"); scroller.scrollTop=640;
 fireEvent.click(result);
 const back=await screen.findByRole("button",{name:"Back"});
 expect(scroller.scrollTop).toBe(0);
 fireEvent.click(back);
 await screen.findByRole("button",{name:/1917 result/});
 expect(scroller.scrollTop).toBe(640);
});
