// @vitest-environment jsdom
import {render,screen,fireEvent,waitFor,cleanup} from "@testing-library/react";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {it,expect,vi,afterEach} from "vitest";
import TranscodingSettings from "./TranscodingSettings";
const request=vi.hoisted(()=>vi.fn());vi.mock("../api/client",()=>({apiRequest:request}));afterEach(()=>{cleanup();vi.clearAllMocks();});
it("saves hardware settings and falls back to AVC when AV1 is disabled",async()=>{
 const value={hardware_enabled:false,hardware_backend:"auto",preferred_encoder:"avc",allow_hevc:false,allow_av1:false,software_fallback:true,max_resolution:1080,max_concurrent:2,threads:0,temporary_path:"",cache_gb:10,throttle:true,buffer_seconds:120,subtitle_extraction:true,font_extraction:true,audio_boost:1};
 request.mockImplementation(async(_url,options)=>options?JSON.parse(options.body):value);
 render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><TranscodingSettings/></QueryClientProvider>);
 fireEvent.click(await screen.findByRole("switch",{name:"Enable hardware transcoding when available"}));
 fireEvent.click(screen.getByRole("switch",{name:"Allow AV1 encoding"}));
 fireEvent.change(screen.getByLabelText("Preferred encoder"),{target:{value:"av1"}});
 fireEvent.click(screen.getByRole("switch",{name:"Allow AV1 encoding"}));
 expect((screen.getByLabelText("Preferred encoder") as HTMLSelectElement).value).toBe("avc");
 fireEvent.click(screen.getByRole("button",{name:"Save configuration"}));
 await waitFor(()=>expect(screen.getByText("Transcoding settings saved.")).toBeTruthy());
 expect(JSON.parse(request.mock.calls.at(-1)![1].body).hardware_enabled).toBe(true);
});
