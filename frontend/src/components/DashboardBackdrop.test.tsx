import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import DashboardBackdrop from "./DashboardBackdrop";

vi.mock("./AnimatedArtwork", () => ({ default: ({ src, active, width, className }: { src: string; active: boolean; width: number; className: string }) => <img src={src} data-active={active} data-width={width} className={className} /> }));

let desktop = true;
let resize: () => void;
beforeEach(() => {
  vi.useFakeTimers();
  desktop = true;
  vi.spyOn(Math, "random").mockReturnValue(0);
  vi.stubGlobal("matchMedia", () => ({ get matches() { return desktop; }, addEventListener: (_event: string, callback: () => void) => { resize = callback; }, removeEventListener: vi.fn() }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const desktopUrls = ["/a.jpg", "/b.jpg", "/c.jpg", "/d.jpg", "/e.jpg", "/f.jpg", "/g.jpg", "/h.jpg"];
const mobileUrls = ["/mobile-a.jpg", "/mobile-b.jpg"];
const images = () => Array.from(screen.getByTestId("dashboard-backdrop").querySelectorAll("img"));

it("loads only the visible viewport's current backdrop and one upcoming backdrop", () => {
  render(<DashboardBackdrop desktopUrls={desktopUrls} mobileUrls={mobileUrls} overlayStrength={50} />);
  expect(images().map(image => image.getAttribute("src"))).toEqual(["/a.jpg", "/b.jpg"]);
  expect(images().map(image => image.dataset.active)).toEqual(["true", "false"]);
  expect(images().every(image => image.dataset.width === "1920")).toBe(true);
  act(() => { desktop = false; resize(); });
  expect(images().map(image => image.getAttribute("src"))).toEqual(mobileUrls);
  expect(images().every(image => image.dataset.width === "640")).toBe(true);
});

it("keeps preloaded and outgoing elements stable through the two-second crossfade", () => {
  const view = render(<DashboardBackdrop desktopUrls={desktopUrls} mobileUrls={mobileUrls} overlayStrength={50} />);
  const [outgoing, upcoming] = images();
  act(() => vi.advanceTimersByTime(12000));
  expect(images()).toEqual([outgoing, upcoming]);
  expect(outgoing.dataset.active).toBe("false");
  expect(upcoming.dataset.active).toBe("true");
  expect(upcoming.className).toContain("duration-[2000ms]");
  act(() => vi.advanceTimersByTime(1999));
  expect(outgoing.isConnected).toBe(true);
  act(() => vi.advanceTimersByTime(1));
  expect(images()).toHaveLength(2);
  expect(images()).toContain(upcoming);
  // A parent render with the same URLs does not reset the twelve-second clock.
  view.rerender(<DashboardBackdrop desktopUrls={[...desktopUrls]} mobileUrls={mobileUrls} overlayStrength={30} />);
  act(() => vi.advanceTimersByTime(10000));
  expect(upcoming.dataset.active).toBe("false");
});

it("handles duplicates, single images, empty collections, and source replacement", () => {
  const view = render(<DashboardBackdrop desktopUrls={["/a.jpg", "/a.jpg"]} mobileUrls={[]} overlayStrength={50} />);
  expect(images()).toHaveLength(1);
  act(() => vi.advanceTimersByTime(36000));
  expect(images()[0].getAttribute("src")).toBe("/a.jpg");
  view.rerender(<DashboardBackdrop desktopUrls={["/new.jpg", "/next.jpg"]} mobileUrls={[]} overlayStrength={50} />);
  expect(images().map(image => image.getAttribute("src"))).toEqual(["/new.jpg", "/next.jpg"]);
  view.rerender(<DashboardBackdrop desktopUrls={[]} mobileUrls={[]} overlayStrength={50} />);
  expect(images()).toHaveLength(0);
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});
