import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import ArtworkSourcesSection from "./ArtworkSourcesSection";
import { api } from "../../../api/client";
vi.mock("../../../api/client", () => ({ api: {getArtworkSettings:vi.fn(), setArtworkSettings:vi.fn(),posterdbStatus:vi.fn(),testArtworkProvider:vi.fn(),setPosterdbCredentials:vi.fn(),posterdbLogin:vi.fn() } }));
vi.mock("../../../components/NativeProviderCredentials", () => ({default:()=>null}));
vi.mock("../../../lib/toast",()=>({useToast:()=>({push:vi.fn()})}));
afterEach(()=>{cleanup();vi.clearAllMocks();sessionStorage.clear();});
function setup(){
 vi.mocked(api.getArtworkSettings).mockResolvedValue({tmdb_configured:true,fanart_configured:true,tvdb_configured:true,comicvine_configured:true} as Awaited<ReturnType<typeof api.getArtworkSettings>>);
 vi.mocked(api.posterdbStatus).mockResolvedValue({configured:true,email:"saved@example.com",logged_in:false} as Awaited<ReturnType<typeof api.posterdbStatus>>);
 vi.mocked(api.setArtworkSettings).mockImplementation(async()=>api.getArtworkSettings());
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 render(<QueryClientProvider client={client}><ArtworkSourcesSection/></QueryClientProvider>);return client;
}
it("does not save credentials on blur and discards draft secrets",async()=>{
 const client=setup();fireEvent.click(screen.getByRole("button",{name:"Configure Fanart.tv"}));
 const region=within(screen.getByRole("region",{name:"Fanart.tv connection"}));
 const input=region.getByLabelText("Fanart.tv API Key");
 fireEvent.change(input,{target:{value:"draft-secret"}});fireEvent.blur(input);
 expect(api.setArtworkSettings).not.toHaveBeenCalled();
 fireEvent.click(region.getByRole("button",{name:"Discard"}));expect((input as HTMLInputElement).value).toBe("");
 fireEvent.change(input,{target:{value:"new-secret"}});fireEvent.click(region.getByRole("button",{name:"Save credentials"}));
 await waitFor(()=>expect(api.setArtworkSettings).toHaveBeenCalledWith({fanart_api_key:"new-secret"}));
 await waitFor(()=>expect((input as HTMLInputElement).value).toBe(""));client.clear();
});
it("preserves blank TVDB keys when saving only a PIN",async()=>{
 const client=setup();fireEvent.click(screen.getByRole("button",{name:"Configure TheTVDB"}));
 const region=within(screen.getByRole("region",{name:"TheTVDB connection"}));
 fireEvent.change(region.getByLabelText("TheTVDB Subscriber PIN (Optional)"),{target:{value:"new-pin"}});
 fireEvent.click(region.getByRole("button",{name:"Save credentials"}));
 await waitFor(()=>expect(api.setArtworkSettings).toHaveBeenCalledWith({tvdb_api_key:undefined,tvdb_pin:"new-pin"}));client.clear();
});
