import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import DashboardBackdrop from "./DashboardBackdrop";

vi.mock("./AnimatedArtwork", () => ({ default: ({ src, active, width, className, onReady, onError }: { src: string; active: boolean; width: number; className: string; onReady: () => void; onError: () => void }) => <img src={src} data-active={active} data-width={width} className={className} onLoad={onReady} onError={onError} /> }));

let desktop = true;
let resize: () => void;
beforeEach(() => {
  vi.useFakeTimers();
  desktop = true;
  sessionStorage.clear();
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
  expect(images().map(image => image.dataset.active)).toEqual(["false", "false"]);
  fireEvent.load(images()[0]);
  expect(images().map(image => image.dataset.active)).toEqual(["true", "false"]);
  expect(images().every(image => image.dataset.width === "1920")).toBe(true);
  act(() => { desktop = false; resize(); });
  expect(images().map(image => image.getAttribute("src"))).toEqual(mobileUrls);
  expect(images().every(image => image.dataset.width === "640")).toBe(true);
});

it("keeps preloaded and outgoing elements stable through the two-second crossfade", () => {
  const view = render(<DashboardBackdrop desktopUrls={desktopUrls} mobileUrls={mobileUrls} overlayStrength={50} />);
  const [outgoing, upcoming] = images();
  fireEvent.load(outgoing);
  fireEvent.load(upcoming);
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
  fireEvent.load(images().find(image => image !== upcoming)!);
  act(() => vi.advanceTimersByTime(12000));
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

it("retains the selected image and rotation clock as more libraries finish loading", () => {
 const view = render(<DashboardBackdrop desktopUrls={["/b.jpg", "/c.jpg"]} mobileUrls={[]} overlayStrength={50}/>);
 const selected = images()[0];
 fireEvent.load(selected);
 fireEvent.load(images()[1]);
 act(() => vi.advanceTimersByTime(6000));
 view.rerender(<DashboardBackdrop desktopUrls={["/a.jpg", "/b.jpg", "/c.jpg"]} mobileUrls={[]} overlayStrength={50}/>);
 expect(images()[0]).toBe(selected);
 expect(selected.dataset.active).toBe("true");
 act(() => vi.advanceTimersByTime(6000));
 expect(selected.dataset.active).toBe("false");
 expect(images().find(image => image.dataset.active === "true")?.getAttribute("src")).toBe("/c.jpg");
});

it("keeps unloaded images hidden and waits for both images before starting rotation", () => {
 render(<DashboardBackdrop desktopUrls={["/a.jpg", "/b.jpg"]} mobileUrls={[]} overlayStrength={50}/>);
 const [current, next] = images();
 act(() => vi.advanceTimersByTime(20000));
 expect(current.className).toContain("opacity-0");
 fireEvent.load(current);
 expect(current.className).toContain("opacity-100");
 expect(current.className).not.toContain("transition-opacity");
 act(() => vi.advanceTimersByTime(20000));
 expect(current.dataset.active).toBe("true");
 fireEvent.load(next);
 act(() => vi.advanceTimersByTime(11999));
 expect(current.dataset.active).toBe("true");
 act(() => vi.advanceTimersByTime(1));
 expect(next.dataset.active).toBe("true");
});

it("skips failed upcoming artwork without hiding the current image", () => {
 render(<DashboardBackdrop desktopUrls={["/a.jpg", "/b.jpg", "/c.jpg"]} mobileUrls={[]} overlayStrength={50}/>);
 const current=images()[0];
 fireEvent.load(current);
 fireEvent.error(images()[1]);
 expect(current.dataset.active).toBe("true");
 expect(images().map(image=>image.getAttribute("src"))).toEqual(["/a.jpg", "/c.jpg"]);
});
it("reuses a decoded backdrop across refresh while the catalog loads, then validates it", () => {
 const saved="/api/native/libraries/library/items/remembered/artwork/backdrop?v=1";
 const fresh="/api/native/libraries/library/items/fresh/artwork/backdrop?v=2";
 const first=render(<DashboardBackdrop desktopUrls={[saved]} mobileUrls={[]} overlayStrength={50} cacheKey="home" allowedLibraryIds={["library"]}/>);
 fireEvent.load(images()[0]);
 first.unmount();
 const view=render(<DashboardBackdrop desktopUrls={[]} mobileUrls={[]} overlayStrength={50} cacheKey="home" loading allowedLibraryIds={["library"]}/>);
 expect(images()[0].getAttribute("src")).toBe(saved);
 expect(images()[0].className).toContain("opacity-0");
 fireEvent.load(images()[0]);
 expect(images()[0].className).toContain("opacity-100");
 view.rerender(<DashboardBackdrop desktopUrls={[saved,fresh]} mobileUrls={[]} overlayStrength={50} cacheKey="home" allowedLibraryIds={["library"]}/>);
 expect(images().find(image=>image.dataset.active==="true")?.getAttribute("src")).toBe(saved);
 view.rerender(<DashboardBackdrop desktopUrls={[fresh]} mobileUrls={[]} overlayStrength={50} cacheKey="home" allowedLibraryIds={["library"]}/>);
 expect(images().some(image=>image.getAttribute("src")===saved)).toBe(false);
});

it("never restores a backdrop belonging to a different library or an external URL", () => {
 const key="posterview.backdrop:server:home:desktop";
 sessionStorage.setItem(key,"/api/native/libraries/revoked/items/item/artwork/backdrop?v=1");
 const first=render(<DashboardBackdrop desktopUrls={[]} mobileUrls={[]} overlayStrength={50} cacheKey="home" loading allowedLibraryIds={["allowed"]}/>);
 expect(images()).toHaveLength(0);
 first.unmount();
 sessionStorage.setItem(key,"https://example.com/artwork.jpg");
 render(<DashboardBackdrop desktopUrls={[]} mobileUrls={[]} overlayStrength={50} cacheKey="home" loading/>);
 expect(images()).toHaveLength(0);
});