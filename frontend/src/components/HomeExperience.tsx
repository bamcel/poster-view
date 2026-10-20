import {startupArtworkState} from "../features/playback/lib/startupArtwork";
import {useHomepageBannerLogo} from "../lib/homepagePreferences";
import SeriesBannerPlay from "./SeriesBannerPlay";
import {useFeaturedRotation} from "../lib/useFeaturedRotation";
import HomeMediaRow from "./HomeMediaRow";
import { mediaDescription } from "../lib/mediaDescription";
import {useEffect,useMemo,useRef,useState} from "react";
import {ChevronLeft,ChevronRight,Film,Info,Play} from "lucide-react";
import {nativeLibraries} from "../api/nativeLibraries";
import {Link} from "../lib/libraryNavigation";
import {nativeArtworkVersion} from "../lib/nativeArtworkCache";
import {stillArtwork} from "./AnimatedArtwork";
import {sizedArtwork} from "../lib/artworkSizes";
import DiscoveryHoverCard from "./DiscoveryHoverCard";
import type {HomeTitle} from "./HomeDiscovery";
import "./HomeExperience.css";

const details=({library,entry}:HomeTitle)=>library.library_type==="youtube"?`/media/${encodeURIComponent(library.id)}?youtube_channel=${encodeURIComponent(String((entry.metadata.youtube as {channel_id?:string}|undefined)?.channel_id??entry.path))}&from=home`:`/media/${encodeURIComponent(library.id)}?native_library=${encodeURIComponent(library.id)}&native_item=${encodeURIComponent(entry.id)}&from=home`;
const play=({library,entry}:HomeTitle)=>`/play/native/${encodeURIComponent(library.id)}/${encodeURIComponent(entry.id)}?return=%2F`;
const playable=({entry}:HomeTitle)=>entry.available&&entry.metadata.missing!==true&&entry.kind==="movie"&&(entry.files.length>0||entry.metadata._has_files===true);
function numeric(value:unknown){if(typeof value!=="number"&&(typeof value!=="string"||!value.trim()))return;const n=Number(value);return Number.isFinite(n)?n:undefined;}
function genres({entry}:HomeTitle){return Array.isArray(entry.metadata.genres)?[...new Set(entry.metadata.genres.filter((v):v is string=>typeof v==="string"&&!!v.trim()).map(v=>v.trim()))]:[];}
function Artwork({title,hero=false}:{title:HomeTitle;hero?:boolean}){
  const kind=(hero?["backdrop","landscape","fanart","thumb","poster"]:["landscape","backdrop","fanart","thumb","poster"]).find(kind=>title.entry.artwork.some(art=>art.kind===kind));
  const src=kind?stillArtwork(`${nativeLibraries.artworkUrl(title.library.id,title.entry.id,kind)}?v=${encodeURIComponent(nativeArtworkVersion(title.entry,kind))}`):undefined;
  const [failed,setFailed]=useState(false);
  useEffect(()=>setFailed(false),[src]);
  return src&&!failed?<img src={hero?src:sizedArtwork(src,640)} srcSet={hero?undefined:`${sizedArtwork(src,320)} 320w, ${sizedArtwork(src,480)} 480w, ${sizedArtwork(src,640)} 640w`} sizes={hero?"100vw":"(min-width: 1200px) 20vw, (min-width: 900px) 25vw, (min-width: 600px) 33vw, 45vw"} alt="" loading={hero?"eager":"lazy"} decoding="async" onError={()=>setFailed(true)}/>:<div className="pv-home-art-fallback"><Film aria-hidden="true"/><span>{title.entry.title}</span></div>;
}

function FeaturedHeading({title}:{title:HomeTitle}){
 const [enabled]=useHomepageBannerLogo();
 const kind=title.entry.artwork.some(art=>art.kind==="logo")?"logo":undefined;
 const src=enabled&&kind?sizedArtwork(`${nativeLibraries.artworkUrl(title.library.id,title.entry.id,kind)}?v=${encodeURIComponent(nativeArtworkVersion(title.entry,kind))}`,640):undefined;
 const [failed,setFailed]=useState<string>();
 return <h2>{src&&failed!==src?<img src={src} alt={title.entry.title} decoding="async" className="pv-home-featured-logo" onError={()=>setFailed(src)}/>:title.entry.title}</h2>;
}

export function FeaturedTitle({titles}:{titles:HomeTitle[]}){
  const candidates=useMemo(()=>{
    const libraries=new Map<string,HomeTitle[]>();
    for(const title of titles){
      if(!title.entry.available||title.entry.metadata.missing===true||!["movie","series"].includes(title.entry.kind)||(!title.entry.artwork.some(art=>["backdrop","landscape","fanart"].includes(art.kind))))continue;
      const group=libraries.get(title.library.id)??[];group.push(title);libraries.set(title.library.id,group);
    }
    const groups=[...libraries.values()],result:HomeTitle[]=[];
    for(let index=0;groups.some(group=>index<group.length);index++)for(const group of groups)if(group[index])result.push(group[index]);
    return result.length?result:titles.filter(({entry})=>entry.available&&entry.metadata.missing!==true).slice(0,1);
  },[titles]);
  const rotation=useFeaturedRotation(candidates.map(({library,entry})=>`${library.id}:${entry.id}`));
  const hovering=useRef(false);
  const title=candidates[rotation.index];
  const banner=useRef<HTMLElement>(null);
  useEffect(()=>{
    const element=banner.current;
    if(!element)return;
    let viewport=element.parentElement;
    while(viewport&&!/(auto|scroll)/.test(getComputedStyle(viewport).overflowY))viewport=viewport.parentElement;
    if(!viewport)return;
    const scroller=viewport;
    let frame=0;
    const update=()=>{
      frame=0;
      const bounds=element.getBoundingClientRect();
      const top=scroller.getBoundingClientRect().top+scroller.clientTop;
      element.style.setProperty("--pv-hero-clip-top",`${Math.min(bounds.height,Math.max(0,top-bounds.top))}px`);
    };
    const schedule=()=>{if(!frame)frame=requestAnimationFrame(update);};
    scroller.addEventListener("scroll",schedule,{passive:true});
    window.addEventListener("resize",schedule);
    const observer=new ResizeObserver(schedule);
    observer.observe(element);
    observer.observe(scroller);
    update();
    return()=>{
      scroller.removeEventListener("scroll",schedule);
      window.removeEventListener("resize",schedule);
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  },[!!title]);
  if(!title)return null;
  const year=numeric(title.entry.metadata.year);
  const rating=typeof title.entry.metadata.mpaa==="string"?title.entry.metadata.mpaa.trim():"";
  const plot=mediaDescription(title.entry.metadata.plot);
  return <section ref={banner} className="pv-home-hero" aria-label="Featured title" aria-roledescription={candidates.length>1?"carousel":undefined} onMouseEnter={()=>{hovering.current=true;rotation.setInteracting(true);}} onMouseLeave={event=>{hovering.current=false;rotation.setInteracting(event.currentTarget.contains(document.activeElement));}} onFocus={()=>rotation.setInteracting(true)} onBlur={event=>rotation.setInteracting(hovering.current||event.currentTarget.contains(event.relatedTarget))}>
    <div className="pv-home-hero-art">{candidates.map((candidate,index)=>({candidate,index})).filter(({index})=>index===rotation.index||index===(rotation.index+1)%candidates.length||index===(rotation.index+candidates.length-1)%candidates.length).map(({candidate,index})=><div key={`${candidate.library.id}:${candidate.entry.id}`} className={`pv-home-hero-slide ${index===rotation.index?"is-current":""}`} aria-hidden="true"><Artwork title={candidate} hero/></div>)}</div>
    {candidates.length>1&&<>
      <button type="button" className="pv-home-edge-arrow pv-home-edge-previous" aria-label="Previous featured title" onClick={rotation.previous}><ChevronLeft aria-hidden="true"/></button>
      <button type="button" className="pv-home-edge-arrow pv-home-edge-next" aria-label="Next featured title" onClick={rotation.next}><ChevronRight aria-hidden="true"/></button>
    </>}
    <div className="pv-home-hero-content">
      <p className="pv-home-eyebrow">Featured · {title.library.name}</p>
      <FeaturedHeading title={title}/>
      <p className="pv-home-hero-meta">{[title.library.library_type==="youtube"?"YouTube channel":title.entry.kind==="series"?"Series":"Movie",year&&year>0?year:null,rating,...genres(title).slice(0,2)].filter(Boolean).join(" · ")}</p>
      {plot&&<p className="pv-home-hero-plot">{plot}</p>}
      <div className="pv-home-actions">
        {playable(title)&&<Link className="pv-home-action pv-home-action-primary" state={startupArtworkState(title.library.id,title.entry)} to={`${play(title)}&start=0`} aria-label={`Play ${title.entry.title}`}><Play aria-hidden="true"/>Play</Link>}
        {title.library.library_type!=="youtube"&&title.entry.kind==="series"&&title.entry.available&&title.entry.metadata.missing!==true&&<SeriesBannerPlay key={`${title.library.id}:${title.entry.id}`} title={title}/>}
        <Link className="pv-home-action" to={details(title)} aria-label={`More info about ${title.entry.title}`}><Info aria-hidden="true"/>More Info</Link>
      </div>
    </div>
  </section>;
}

function LandscapeRow({label,titles}:{label:string;titles:HomeTitle[]}){
  return <HomeMediaRow label={label}>{titles.slice(0,20).map(title=><article className="pv-home-landscape-card" key={`${title.library.id}:${title.entry.id}`}>
      <DiscoveryHoverCard title={title}>
        <Link className="pv-home-card-link" to={details(title)} aria-label={`Open ${title.entry.title} in ${title.library.name}`}><div className="pv-home-landscape-art"><Artwork title={title}/></div><h3>{title.entry.title}</h3></Link>
      </DiscoveryHoverCard>
    </article>)}</HomeMediaRow>;
}

export default function HomeExperience({titles}:{titles:HomeTitle[]}){
  const rows=useMemo(()=>{
    const available=titles.filter(title=>title.entry.available&&title.entry.metadata.missing!==true);
    const rated=available.filter(title=>{const value=numeric(title.entry.metadata.rating);return value!==undefined&&value>=7&&value<=10;}).sort((a,b)=>numeric(b.entry.metadata.rating)!-numeric(a.entry.metadata.rating)!);
    const recent=available.filter(title=>{const year=numeric(title.entry.metadata.year);return year!==undefined&&Number.isInteger(year)&&year>0&&year<=9999;}).sort((a,b)=>numeric(b.entry.metadata.year)!-numeric(a.entry.metadata.year)!);
    const groups=new Map<string,{label:string;titles:HomeTitle[]}>();
    for(const title of available)for(const genre of genres(title)){const key=genre.toLocaleLowerCase(),group=groups.get(key)??{label:genre,titles:[]};if(!group.titles.includes(title))group.titles.push(title);groups.set(key,group);}
    const rows=[{label:"Highly Rated",titles:rated},{label:"Recent Releases",titles:recent},...[...groups.values()].filter(group=>group.titles.length>=2).sort((a,b)=>b.titles.length-a.titles.length||a.label.localeCompare(b.label)).slice(0,2)].filter(row=>row.titles.length);
    return rows.length?rows:available.length?[{label:"Explore Your Libraries",titles:available}]:[];
  },[titles]);
  return <div className="pv-home-discovery">{rows.map(row=><LandscapeRow key={row.label} {...row}/>)}</div>;
}
