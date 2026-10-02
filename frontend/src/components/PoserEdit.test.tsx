import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {cleanup, fireEvent, render, screen, waitFor} from "@testing-library/react";
import {afterEach, expect, it, vi} from "vitest";
import PoserEdit from "./PoserEdit";
import {api} from "../api/client";
vi.mock("../api/client",()=>({api:{applyUpload:vi.fn()}}));
vi.mock("../lib/toast",()=>({useToast:()=>({push:vi.fn()})}));
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
function show(poster="/poster.png",logo:string|undefined="/logo.png") {
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 return render(<QueryClientProvider client={client}><PoserEdit serverId={1} item={{id:"series",title:"Series",type:"show",poster,logo,seasons:[],members:[],external_ids:{}}}/></QueryClientProvider>);
}
it("positions and resizes the logo without altering the poster preview",()=>{
 show();
 fireEvent.change(screen.getByRole("slider",{name:"Logo size"}),{target:{value:"40"}});
 fireEvent.click(screen.getByRole("button",{name:"Center"}));
 const logo=screen.getByAltText("Drag series logo");
 expect(logo.style.width).toBe("40%");expect(logo.style.left).toBe("30%");
 fireEvent.click(screen.getByRole("checkbox",{name:"Display logo"}));
 expect(screen.queryByAltText("Drag series logo")).toBeNull();
 fireEvent.click(screen.getByRole("button",{name:"Reset"}));
 expect(screen.getByAltText("Drag series logo").style.width).toBe("70%");
});
it("exports the composite through the existing server artwork upload",async()=>{
 const drawImage=vi.fn();
 vi.stubGlobal("Image",class {naturalWidth=1000;naturalHeight=1500;onload?:()=>void;set src(_value:string){queueMicrotask(()=>this.onload?.());}});
 vi.spyOn(HTMLCanvasElement.prototype,"getContext").mockReturnValue({drawImage,globalAlpha:1} as unknown as CanvasRenderingContext2D);
 vi.spyOn(HTMLCanvasElement.prototype,"toBlob").mockImplementation(callback=>callback(new Blob(["poster"],{type:"image/png"})));
 vi.mocked(api.applyUpload).mockResolvedValue({ok:true,message:"Saved"});
 show();fireEvent.click(screen.getByRole("button",{name:"Save poster"}));
 await waitFor(()=>expect(api.applyUpload).toHaveBeenCalledOnce());
 expect(drawImage).toHaveBeenCalledTimes(2);
 expect(vi.mocked(api.applyUpload).mock.calls[0][0]).toMatchObject({server_id:1,item_id:"series",target:"poster"});
});
it("explains missing logo before allowing editing",()=>{show("/poster.png","");expect(screen.getByText(/Add a poster and a series logo/)).toBeTruthy();expect(screen.queryByRole("button",{name:"Save poster"})).toBeNull();});
