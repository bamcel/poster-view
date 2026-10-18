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
it("automatically saves credentials locally and leaves blank saved secrets untouched",async()=>{
 const client=setup();fireEvent.click(screen.getByRole("button",{name:"Configure Fanart.tv"}));
 const region=within(screen.getByRole("region",{name:"Fanart.tv connection"}));
 const input=region.getByLabelText("Fanart.tv API Key");
 await waitFor(()=>expect((input as HTMLInputElement).disabled).toBe(false));
 expect(api.setArtworkSettings).not.toHaveBeenCalled();
 fireEvent.change(input,{target:{value:"new-secret"}});
 expect((region.getByRole("button",{name:"Test Connection"}) as HTMLButtonElement).disabled).toBe(true);
 expect(region.queryByRole("button",{name:"Save credentials"})).toBeNull();
 await waitFor(()=>expect(api.setArtworkSettings).toHaveBeenCalledWith({fanart_api_key:"new-secret"}));
 expect(await region.findByText("Changes saved automatically")).toBeTruthy();client.clear();
});
it("preserves blank TVDB keys when saving only a PIN",async()=>{
 const client=setup();fireEvent.click(screen.getByRole("button",{name:"Configure TheTVDB"}));
 const region=within(screen.getByRole("region",{name:"TheTVDB connection"}));
 await waitFor(()=>expect((region.getByLabelText("TheTVDB Subscriber PIN (Optional)") as HTMLInputElement).disabled).toBe(false));
 fireEvent.change(region.getByLabelText("TheTVDB Subscriber PIN (Optional)"),{target:{value:"new-pin"}});

 await waitFor(()=>expect(api.setArtworkSettings).toHaveBeenCalledWith({tvdb_pin:"new-pin"}));client.clear();
});

it("reports a failed automatic credential save locally and retries without testing unsaved values",async()=>{
 const client=setup();
 fireEvent.click(screen.getByRole("button",{name:"Configure TMDB"}));
 const region=within(screen.getByRole("region",{name:"TMDB connection"}));
 const input=region.getByLabelText("TMDB API Read Access Token or API key");
 await waitFor(()=>expect((input as HTMLInputElement).disabled).toBe(false));
 vi.mocked(api.setArtworkSettings).mockRejectedValueOnce(new Error("Unable to connect"));
 fireEvent.change(input,{target:{value:"replacement-token"}});
 expect(await region.findByRole("alert")).toHaveProperty("textContent",expect.stringContaining("Unable to connect"));
 expect((region.getByRole("button",{name:"Test Connection"}) as HTMLButtonElement).disabled).toBe(true);
 fireEvent.click(region.getByRole("button",{name:"Retry"}));
 expect(await region.findByText("Changes saved automatically")).toBeTruthy();
 await waitFor(()=>expect((region.getByRole("button",{name:"Test Connection"}) as HTMLButtonElement).disabled).toBe(false));
 client.clear();
});
