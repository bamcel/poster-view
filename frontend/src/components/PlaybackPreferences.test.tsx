// @vitest-environment jsdom
import {render,screen,fireEvent,cleanup,waitFor} from "@testing-library/react";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {afterEach,expect,it,vi} from "vitest";
import PlaybackPreferences from "./PlaybackPreferences";
import {watchApi} from "../api/watch";
vi.mock("../api/watch",()=>({watchApi:{preferences:vi.fn(),savePreferences:vi.fn()}}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
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
