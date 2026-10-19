import {cleanup, fireEvent, render, screen, waitFor} from "@testing-library/react";
import {MemoryRouter, useLocation, useNavigate} from "react-router-dom";
import {afterEach, expect, it} from "vitest";
import {PlaybackNavigationProvider, usePlaybackReturn} from "./playbackNavigation";

afterEach(cleanup);

function NavigationHarness({returnPath = "/series"}: {returnPath?: string}) {
  const location = useLocation();
  const navigate = useNavigate();
  const returnFromPlayback = usePlaybackReturn(returnPath);
  return <>
    <output aria-label="Current route">{location.pathname}{location.search}</output>
    <button onClick={() => navigate(returnPath)}>Open series</button>
    <button onClick={() => navigate("/player/episode-1")}>Play</button>
    <button onClick={() => navigate("/player/episode-2", {replace: true})}>Next episode</button>
    <button onClick={returnFromPlayback}>Return from playback</button>
    <button onClick={() => navigate(-1)}>Back</button>
  </>;
}

function mount({entries = ["/browse"], returnPath = "/series"}: {entries?: string[]; returnPath?: string} = {}) {
  render(<MemoryRouter initialEntries={entries}>
    <PlaybackNavigationProvider><NavigationHarness returnPath={returnPath}/></PlaybackNavigationProvider>
  </MemoryRouter>);
}

async function clickAndExpect(button: string, route: string) {
  fireEvent.click(screen.getByRole("button", {name: button}));
  await waitFor(() => expect(screen.getByLabelText("Current route").textContent).toBe(route));
}

it("returns to the series history entry so Back continues to the library instead of reopening playback", async () => {
  mount();
  await clickAndExpect("Open series", "/series");
  await clickAndExpect("Play", "/player/episode-1");
  await clickAndExpect("Return from playback", "/series");
  await clickAndExpect("Back", "/browse");
});

it("replaces a directly entered player when its return page was never visited", async () => {
  mount({entries: ["/browse", "/player/episode-1"]});
  await clickAndExpect("Return from playback", "/series");
  await clickAndExpect("Back", "/browse");
});

it("retains the return entry when automatic episode advancement replaces the player route", async () => {
  mount();
  await clickAndExpect("Open series", "/series");
  await clickAndExpect("Play", "/player/episode-1");
  await clickAndExpect("Next episode", "/player/episode-2");
  await clickAndExpect("Return from playback", "/series");
  await clickAndExpect("Back", "/browse");
});

it("handles browser Back followed by opening playback again without retaining obsolete player entries", async () => {
  mount();
  await clickAndExpect("Open series", "/series");
  await clickAndExpect("Play", "/player/episode-1");
  await clickAndExpect("Back", "/series");
  await clickAndExpect("Play", "/player/episode-1");
  await clickAndExpect("Return from playback", "/series");
  await clickAndExpect("Back", "/browse");
});

it("preserves return-page query parameters when returning through history", async () => {
  mount({returnPath: "/series?season=2&sort=episode"});
  await clickAndExpect("Open series", "/series?season=2&sort=episode");
  await clickAndExpect("Play", "/player/episode-1");
  await clickAndExpect("Return from playback", "/series?season=2&sort=episode");
  await clickAndExpect("Back", "/browse");
});

it("preserves return-page query parameters in the direct-entry fallback", async () => {
  mount({entries: ["/browse", "/player/episode-1"], returnPath: "/series?season=2"});
  await clickAndExpect("Return from playback", "/series?season=2");
  await clickAndExpect("Back", "/browse");
});
