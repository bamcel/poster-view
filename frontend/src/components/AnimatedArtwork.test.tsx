import {act, cleanup, render, screen} from "@testing-library/react";
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import AnimatedArtwork from "./AnimatedArtwork";

let intersect: IntersectionObserverCallback;
let reduce = false;
beforeEach(()=>{
  reduce=false;
  vi.stubGlobal("IntersectionObserver",class {
    constructor(callback: IntersectionObserverCallback){intersect=callback;}
    observe(){} disconnect(){}
  });
  vi.stubGlobal("matchMedia",()=>({matches:reduce,addEventListener:vi.fn(),removeEventListener:vi.fn()}));
  vi.spyOn(HTMLMediaElement.prototype,"play").mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype,"pause").mockImplementation(()=>{});
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
const src="/api/native/libraries/library/items/item/artwork/poster?v=1&format=webm";
function visible(value:boolean){act(()=>intersect([{isIntersecting:value} as IntersectionObserverEntry],{} as IntersectionObserver));}
it("loops muted video while visible and falls back when offscreen",()=>{
  render(<AnimatedArtwork src={src} alt="Poster"/>);
  expect(screen.getByAltText("Poster").getAttribute("src")).toContain("still=1");
  visible(true);
  const video=screen.getByLabelText("Poster") as HTMLVideoElement;
  expect(video.preload).toBe("auto");expect(video.loop).toBe(true);expect(video.muted).toBe(true);expect(video.autoplay).toBe(true);expect(video.playsInline).toBe(true);expect(video.controls).toBe(false);
  visible(false);
  expect(screen.queryByLabelText("Poster")).toBeNull();
  expect(screen.getByAltText("Poster").getAttribute("src")).toContain("still=1");
});
it("uses the static frame when reduced motion is enabled",()=>{
  reduce=true;
  render(<AnimatedArtwork src={src} alt="Poster"/>);visible(true);
  expect(screen.queryByLabelText("Poster")).toBeNull();
  expect(screen.getByAltText("Poster").getAttribute("src")).toContain("still=1");
});
it("suspends GIF animation when its backdrop layer is inactive",()=>{
  const gif=src.replace("format=webm","format=gif");
  const view=render(<AnimatedArtwork src={gif} alt="Backdrop"/>);visible(true);
  expect(screen.getByAltText("Backdrop").getAttribute("src")).toBe(gif);
  view.rerender(<AnimatedArtwork src={gif} alt="Backdrop" active={false}/>);
  expect(screen.getByAltText("Backdrop").getAttribute("src")).toContain("still=1");
});

it("switches to the static frame while the browser tab is hidden",()=>{
  render(<AnimatedArtwork src={src} alt="Poster"/>);visible(true);
  expect(screen.getByLabelText("Poster")).toBeTruthy();
  vi.spyOn(document,"hidden","get").mockReturnValue(true);
  act(()=>document.dispatchEvent(new Event("visibilitychange")));
  expect(screen.queryByLabelText("Poster")).toBeNull();
  expect(screen.getByAltText("Poster").getAttribute("src")).toContain("still=1");
});

it("renders saved animated poster logos with their stored placement",()=>{
  const overlay=encodeURIComponent(JSON.stringify({logo:"/api/native/libraries/library/items/item/artwork/logo",x:10,y:70,width:80,opacity:60}));
  const view=render(<AnimatedArtwork src={`${src}&logoOverlay=${overlay}`} alt="Poster"/>);visible(true);
  const logo=view.container.querySelector('img[aria-hidden="true"]') as HTMLImageElement;
  expect(logo.style.left).toBe("10%");expect(logo.style.width).toBe("80%");expect(logo.style.opacity).toBe("0.6");
  expect(screen.getByLabelText("Poster")).toBeTruthy();
});

it("renders a saved overlay on static artwork without replacing its image",()=>{
 const source="/api/native/libraries/library/items/item/artwork/poster?format=png";
 const overlay=encodeURIComponent(JSON.stringify({logo:"/api/native/libraries/library/items/item/artwork/logo",x:15,y:72,width:70,opacity:100}));
 const view=render(<AnimatedArtwork src={`${source}&logoOverlay=${overlay}`} alt="Static poster"/>);
 expect(screen.getByAltText("Static poster").getAttribute("src")).toBe(`${source}&logoOverlay=${overlay}`);
 expect(view.container.querySelector('img[aria-hidden="true"]')).toBeTruthy();
});
