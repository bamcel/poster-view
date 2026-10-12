import {cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {afterEach,expect,it,vi} from "vitest";
import {apiRequest} from "../../../api/client";
import TranscodingSettings,{type TranscodingSettingsValue} from "./TranscodingSettings";

vi.mock("../../../api/client",()=>({apiRequest:vi.fn()}));
const settings:TranscodingSettingsValue={allow_conversion:false,allow_audio_transcoding:false,auto_bandwidth_transcoding:false,allow_remux:true,hardware_enabled:false,hardware_backend:"auto",preferred_encoder:"avc",allow_hevc:false,allow_av1:false,software_fallback:true,max_resolution:1080,max_concurrent:2,threads:0,temporary_path:"",cache_gb:10,throttle:true,buffer_seconds:120,subtitle_extraction:true,font_extraction:true,audio_boost:1};
afterEach(()=>{cleanup();vi.resetAllMocks();});
function mount(){const client=new QueryClient({defaultOptions:{queries:{retry:false}}});render(<QueryClientProvider client={client}><TranscodingSettings/></QueryClientProvider>);return client;}

it("saves independent audio permission while leaving video and bandwidth encoding disabled",async()=>{
  vi.mocked(apiRequest).mockImplementation(async(path,options)=>path==="/transcoding/settings"&&options?.method==="PUT"?JSON.parse(String(options.body)):settings);
  const client=mount();
  fireEvent.click(await screen.findByRole("switch",{name:"Allow audio-only transcoding"}));
  fireEvent.click(screen.getByRole("button",{name:"Save configuration"}));
  await screen.findByText("Transcoding settings saved.");
  const write=vi.mocked(apiRequest).mock.calls.find(([,options])=>options?.method==="PUT")!;
  expect(JSON.parse(String(write[1]?.body))).toMatchObject({allow_audio_transcoding:true,allow_conversion:false,auto_bandwidth_transcoding:false,allow_remux:true});
  client.clear();
});

it("reports a rejected save without announcing success",async()=>{
  vi.mocked(apiRequest).mockImplementation(async(_path,options)=>{if(options?.method==="PUT")throw new Error("Temporary path must be an absolute server path.");return settings;});
  const client=mount();
  fireEvent.change(await screen.findByLabelText(/Transcoding temporary path/),{target:{value:"relative"}});
  fireEvent.click(screen.getByRole("button",{name:"Save configuration"}));
  expect((await screen.findByRole("alert")).textContent).toContain("Temporary path must be an absolute server path.");
  expect(screen.queryByText("Transcoding settings saved.")).toBeNull();
  client.clear();
});

it("runs hardware checks on demand and displays actual probe results",async()=>{
  vi.mocked(apiRequest).mockImplementation(async(path)=>path==="/playback/capabilities"?{encoders:[{name:"h264_qsv",backend:"qsv",codec:"h264",available:true,detail:"Small encode succeeded."},{name:"av1_nvenc",backend:"nvenc",codec:"av1",available:false,detail:"No encoder device."}]}:{...settings,allow_conversion:true});
  const client=mount();
  await screen.findByRole("switch",{name:"Allow video transcoding"});
  expect(vi.mocked(apiRequest).mock.calls.some(([path])=>path==="/playback/capabilities")).toBe(false);
  fireEvent.click(screen.getByRole("button",{name:"Test hardware encoders"}));
  await waitFor(()=>expect(screen.getByLabelText("Hardware encoder results").textContent).toContain("h264_qsvH264Test passed"));
  expect(screen.getByLabelText("Hardware encoder results").textContent).toContain("av1_nvencAV1Unavailable");
  client.clear();
});
