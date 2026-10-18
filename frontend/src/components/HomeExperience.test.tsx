import {cleanup,fireEvent,render,screen,within} from "@testing-library/react";
import {MemoryRouter} from "react-router-dom";
import {afterEach,expect,it,vi} from "vitest";
import HomeExperience,{FeaturedTitle} from "./HomeExperience";
import type {HomeTitle} from "./HomeDiscovery";
import type {NativeLibrary} from "../api/nativeLibraries";
vi.mock("./SeriesBannerPlay",()=>({default:({title}:{title:HomeTitle})=><button aria-label={`Play ${title.entry.title}`}>Play</button>}));
function title(name:string,metadata:Record<string,unknown>={}):HomeTitle{return {library:{id:"movie library",name:"Movies"} as NativeLibrary,entry:{id:name,title:name,path:name,kind:"movie",parent_path:null,available:true,revision:1,metadata,artwork:[],files:[{path:"movie.mkv",size:1,extension:"mkv"}],nfo_path:null}};}
afterEach(()=>{localStorage.clear();cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
it("features scene artwork with real metadata and existing encoded routes",()=>{
  const movie=title("Movie/one",{year:2025,mpaa:"PG-13",plot:"A journey home",genres:["Drama"]});movie.entry.artwork=[{kind:"backdrop",path:"backdrop.jpg",source:"local"}];
  render(<MemoryRouter><FeaturedTitle titles={[title("No art"),movie]}/></MemoryRouter>);
  const hero=screen.getByRole("region",{name:"Featured title"});expect(within(hero).getByRole("heading",{name:"Movie/one"})).toBeTruthy();
  expect(within(hero).getByText("Movie · 2025 · PG-13 · Drama")).toBeTruthy();expect(within(hero).getByText("A journey home")).toBeTruthy();
  expect(within(hero).getByRole("link",{name:"Play Movie/one"}).getAttribute("href")).toBe("/play/native/movie%20library/Movie%2Fone?return=%2F&start=0");
  const bannerImage=hero.querySelector("img")!;
  expect(bannerImage.getAttribute("src")).toContain("/artwork/backdrop?");
  expect(new URL(bannerImage.src).searchParams.has("width")).toBe(false);
  expect(bannerImage.hasAttribute("srcset")).toBe(false);
  expect(within(hero).getByRole("link",{name:"More info about Movie/one"}).getAttribute("href")).toContain("native_item=Movie%2Fone&from=home");
});
it("prefers landscape art in rows and keeps accessible details if the image fails",()=>{
  const movie=title("Scene");movie.entry.artwork=[{kind:"poster",path:"poster.jpg",source:"local"},{kind:"landscape",path:"scene.jpg",source:"local"}];
  const view=render(<MemoryRouter><HomeExperience titles={[movie]}/></MemoryRouter>);
  const image=view.container.querySelector("img")!;expect(image.src).toContain("/artwork/landscape?");fireEvent.error(image);expect(view.container.querySelector("img")).toBeNull();
  expect(screen.getByRole("link",{name:"Open Scene in Movies"})).toBeTruthy();expect(screen.getByRole("button",{name:"Preview Scene"})).toBeTruthy();
});
it("sorts discovery by valid metadata and excludes unavailable or missing titles",()=>{
  const missing=title("Missing",{rating:10,year:2026,missing:true}),unavailable=title("Unavailable",{rating:10});unavailable.entry.available=false;
  render(<MemoryRouter><HomeExperience titles={[title("Older",{year:2000,rating:"8.1"}),title("Newer",{year:2026,rating:9}),title("Invalid",{year:true,rating:99}),missing,unavailable]}/></MemoryRouter>);
  const names=(row:string)=>within(screen.getByRole("region",{name:row})).getAllByRole("link",{name:/^Open /}).map(link=>link.getAttribute("aria-label"));
  expect(names("Highly Rated")).toEqual(["Open Newer in Movies","Open Older in Movies"]);expect(names("Recent Releases")).toEqual(["Open Newer in Movies","Open Older in Movies"]);
  expect(screen.queryByText("Missing")).toBeNull();expect(screen.queryByText("Unavailable")).toBeNull();
});
it("bounds rows and honors reduced motion for page navigation",()=>{
  vi.spyOn(HTMLElement.prototype,"clientWidth","get").mockReturnValue(500);vi.spyOn(HTMLElement.prototype,"scrollWidth","get").mockReturnValue(2000);
  vi.stubGlobal("matchMedia",vi.fn().mockReturnValue({matches:true}));const scroll=vi.fn();Object.defineProperty(HTMLElement.prototype,"scrollBy",{configurable:true,value:scroll});
  render(<MemoryRouter><HomeExperience titles={Array.from({length:30},(_,i)=>title(`Movie ${i}`))}/></MemoryRouter>);
  expect(screen.getAllByRole("link",{name:/^Open /})).toHaveLength(20);fireEvent.click(screen.getByRole("button",{name:"Scroll Explore Your Libraries right"}));expect(scroll).toHaveBeenCalledWith({left:425,behavior:"instant"});
  delete(HTMLElement.prototype as {scrollBy?:unknown}).scrollBy;
});
it("does not offer invalid playback and renders nothing for empty discoveries",()=>{
  const movie=title("No files");movie.entry.files=[];const view=render(<MemoryRouter><FeaturedTitle titles={[movie]}/></MemoryRouter>);
  expect(screen.queryByRole("link",{name:/^Play /})).toBeNull();view.rerender(<MemoryRouter><FeaturedTitle titles={[]}/><HomeExperience titles={[]}/></MemoryRouter>);expect(screen.queryByRole("region")).toBeNull();
});

it("preserves movie playback actions from lightweight summaries",()=>{
 const movie=title("Summary movie",{_has_files:true});movie.entry.files=[];
 render(<MemoryRouter><FeaturedTitle titles={[movie]}/></MemoryRouter>);
 expect(screen.getByRole("link",{name:"Play Summary movie"}).getAttribute("href")).toContain("/play/native/movie%20library/Summary%20movie");
});

it("rotates artwork and title actions together across libraries",()=>{
 const first=title("First movie"),another=title("Second movie"),series=title("A series");
 series.entry.kind="series";series.library={...series.library,id:"anime",name:"Anime"};
 for(const item of [first,another,series])item.entry.artwork=[{kind:"backdrop",path:"bright.jpg",source:"local"}];
 const missing=title("Missing",{missing:true});missing.entry.artwork=first.entry.artwork;
 render(<MemoryRouter><FeaturedTitle titles={[first,another,series,missing]}/></MemoryRouter>);
 const banner=screen.getByRole("region",{name:"Featured title"});
 expect(within(banner).getByRole("heading",{name:"First movie"})).toBeTruthy();
 expect(within(banner).queryByText("1 / 3")).toBeNull();
 expect(within(banner).queryByRole("button",{name:/banner rotation/})).toBeNull();
 fireEvent.click(screen.getByRole("button",{name:"Next featured title"}));
 expect(within(banner).getByRole("heading",{name:"A series"})).toBeTruthy();
 expect(within(banner).getByRole("button",{name:"Play A series"})).toBeTruthy();
 expect(within(banner).queryByRole("link",{name:"Play First movie"})).toBeNull();
 fireEvent.click(screen.getByRole("button",{name:"Previous featured title"}));
 expect(within(banner).getByRole("heading",{name:"First movie"})).toBeTruthy();
});

it("prefers selected backdrops for the banner while rows keep landscape artwork",()=>{
 const movie=title("Selected artwork");movie.entry.artwork=[{kind:"landscape",path:"landscape.jpg",source:"local"},{kind:"backdrop",path:"backdrop.jpg",source:"local"}];
 const view=render(<MemoryRouter><FeaturedTitle titles={[movie]}/></MemoryRouter>);
 expect(view.container.querySelector("img")?.getAttribute("src")).toContain("/artwork/backdrop?");
 movie.entry.artwork=movie.entry.artwork.filter(art=>art.kind!=="backdrop");
 view.rerender(<MemoryRouter><FeaturedTitle titles={[movie]}/></MemoryRouter>);
 expect(view.container.querySelector("img")?.getAttribute("src")).toContain("/artwork/landscape?");
});

it("ignores the retired banner preference and uses backdrop artwork",()=>{
 localStorage.setItem("posterview:homepage-headline:local","banner");
 const movie=title("Backdrop title");movie.entry.artwork=[{kind:"backdrop",path:"backdrop.jpg",source:"local"},{kind:"banner",path:"banner.jpg",source:"local"}];
 const view=render(<MemoryRouter><FeaturedTitle titles={[movie]}/></MemoryRouter>);
 expect(view.container.querySelector("img")?.getAttribute("src")).toContain("/artwork/backdrop?");
});

it("uses the saved banner logo preference and falls back to text on failure",()=>{
 const movie=title("Logo movie");movie.entry.artwork=[{kind:"logo",path:"logo.png",source:"local"}];
 const view=render(<MemoryRouter><FeaturedTitle titles={[movie]}/></MemoryRouter>);
 expect(screen.getByRole("heading",{name:"Logo movie"}).textContent).toBe("Logo movie");
 localStorage.setItem("posterview:homepage-banner-logo:local","true");
 view.unmount();
 render(<MemoryRouter><FeaturedTitle titles={[movie]}/></MemoryRouter>);
 const logo=screen.getByRole("img",{name:"Logo movie"});
 expect(logo.getAttribute("src")).toContain("/artwork/logo?");
 expect(new URL((logo as HTMLImageElement).src).searchParams.get("width")).toBe("640");
 fireEvent.error(logo);
 expect(screen.getByRole("heading",{name:"Logo movie"}).textContent).toBe("Logo movie");
});
