// @vitest-environment jsdom
import {render,screen,fireEvent,cleanup,waitFor} from "@testing-library/react";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {afterEach,expect,it,vi} from "vitest";
import PlaybackPreferences from "./PlaybackPreferences";
import {watchApi} from "../api/watch";
import {defaultPlaybackPreferences} from "../types";
vi.mock("../api/watch",()=>({watchApi:{preferences:vi.fn(),savePreferences:vi.fn(),clearTrackSelections:vi.fn()}}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
it("shows and saves independent paused prompt and unanswered exit timeouts",async()=>{
  vi.mocked(watchApi.preferences).mockResolvedValue(defaultPlaybackPreferences);
  vi.mocked(watchApi.savePreferences).mockImplementation(async value=>value);
  render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><PlaybackPreferences/></QueryClientProvider>);
  const prompt=await screen.findByLabelText(/Paused inactivity before prompt/) as HTMLInputElement;
  const exit=screen.getByLabelText(/Unanswered prompt before exit/) as HTMLInputElement;
  expect(prompt.value).toBe("5");expect(exit.value).toBe("5");
  fireEvent.change(prompt,{target:{value:"2"}});fireEvent.change(exit,{target:{value:"3"}});
  fireEvent.click(screen.getByRole("button",{name:"Save preferences"}));
  await screen.findByText("Playback preferences saved.");
  expect(watchApi.savePreferences).toHaveBeenCalledWith(expect.objectContaining({still_watching_minutes:2,still_watching_timeout_minutes:3}));
});
it("preserves ordered language entries and reports a successful server save",async()=>{
  const defaults={audio_languages:["en"],subtitle_languages:["en"],prefer_default_audio:true,remember_audio:true,remember_subtitles:true,subtitle_mode:"default" as const,autoplay_next:true,resume_rewind_seconds:5,skip_back_seconds:10,skip_forward_seconds:30,still_watching_minutes:120,up_next:true,subtitle_size:100};
  vi.mocked(watchApi.preferences).mockResolvedValue(defaults);
  vi.mocked(watchApi.savePreferences).mockImplementation(async value=>value);
  render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><PlaybackPreferences/></QueryClientProvider>);
  fireEvent.change(await screen.findByLabelText("Preferred audio languages"),{target:{value:"ja, en"}});
  fireEvent.click(screen.getByRole("switch",{name:"Play next episode automatically"}));
  fireEvent.click(screen.getByRole("button",{name:"Save preferences"}));
  await waitFor(()=>expect(screen.getByText("Playback preferences saved.")).toBeTruthy());
  expect(watchApi.savePreferences).toHaveBeenCalledWith(expect.objectContaining({audio_languages:["ja","en"],autoplay_next:false}));
});
it("loads legacy subtitle appearance defaults and saves selected plain-text formatting",async()=>{
  const legacy={...defaultPlaybackPreferences,subtitle_color:undefined,subtitle_shadow:undefined,subtitle_background:undefined,subtitle_position:undefined};
  vi.mocked(watchApi.preferences).mockResolvedValue(legacy);vi.mocked(watchApi.savePreferences).mockImplementation(async value=>value);
  render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><PlaybackPreferences/></QueryClientProvider>);
  const color=await screen.findByLabelText("Text subtitle color") as HTMLInputElement;
  expect(color.value).toBe("#ffffff");expect((screen.getByLabelText("Text subtitle shadow") as HTMLSelectElement).value).toBe("none");expect((screen.getByLabelText("Text subtitle background") as HTMLSelectElement).value).toBe("dark");expect((screen.getByLabelText("Text subtitle position") as HTMLSelectElement).value).toBe("auto");
  fireEvent.change(color,{target:{value:"#ffee00"}});fireEvent.change(screen.getByLabelText("Text subtitle shadow"),{target:{value:"outline"}});fireEvent.change(screen.getByLabelText("Text subtitle background"),{target:{value:"none"}});fireEvent.change(screen.getByLabelText("Text subtitle position"),{target:{value:"top"}});
  fireEvent.click(screen.getByRole("button",{name:"Save preferences"}));await screen.findByText("Playback preferences saved.");
  expect(watchApi.savePreferences).toHaveBeenCalledWith(expect.objectContaining({subtitle_color:"#ffee00",subtitle_shadow:"outline",subtitle_background:"none",subtitle_position:"top",subtitle_size:100}));
});

it("lets each profile disable series track memory independently of per-video memory",async()=>{
  vi.mocked(watchApi.preferences).mockResolvedValue(defaultPlaybackPreferences);vi.mocked(watchApi.savePreferences).mockImplementation(async value=>value);
  render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><PlaybackPreferences/></QueryClientProvider>);
  const option=await screen.findByRole("switch",{name:"Remember audio and subtitles track selections"}) as HTMLInputElement;expect(option.checked).toBe(true);
  fireEvent.click(option);fireEvent.click(screen.getByRole("button",{name:"Save preferences"}));await screen.findByText("Playback preferences saved.");
  expect(watchApi.savePreferences).toHaveBeenCalledWith(expect.objectContaining({remember_series_tracks:false,remember_audio:true,remember_subtitles:true}));
});

it("clears saved track selections without submitting preferences and prevents duplicate requests",async()=>{
  vi.mocked(watchApi.preferences).mockResolvedValue(defaultPlaybackPreferences);
  let finish!:()=>void;vi.mocked(watchApi.clearTrackSelections).mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><PlaybackPreferences/></QueryClientProvider>);
  const button=await screen.findByRole("button",{name:"Clear saved track selections"});fireEvent.click(button);
  expect((button as HTMLButtonElement).disabled).toBe(true);fireEvent.click(button);expect(watchApi.clearTrackSelections).toHaveBeenCalledTimes(1);expect(watchApi.savePreferences).not.toHaveBeenCalled();
  finish();await screen.findByText("Saved track selections cleared for your profile.");expect((button as HTMLButtonElement).disabled).toBe(false);
});
it("reports a failed clear and allows retry",async()=>{
  vi.mocked(watchApi.preferences).mockResolvedValue(defaultPlaybackPreferences);vi.mocked(watchApi.clearTrackSelections).mockRejectedValueOnce(new Error("Reset failed"));
  render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><PlaybackPreferences/></QueryClientProvider>);
  fireEvent.click(await screen.findByRole("button",{name:"Clear saved track selections"}));expect(await screen.findByRole("alert")).toHaveProperty("textContent","Reset failed");
  expect((screen.getByRole("button",{name:"Clear saved track selections"}) as HTMLButtonElement).disabled).toBe(false);
});
