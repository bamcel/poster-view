import { mediaDescription } from "../lib/mediaDescription";
import {useEffect,useId,useMemo,useRef,useState} from "react";
import {ChevronLeft,ChevronRight,Film,Info,Play} from "lucide-react";
import {nativeLibraries} from "../api/nativeLibraries";
import {Link} from "../lib/libraryNavigation";
import {nativeArtworkVersion} from "../lib/nativeArtworkCache";
import {stillArtwork} from "./AnimatedArtwork";
import {sizedArtwork} from "../lib/artworkSizes";
import DiscoveryHoverCard from "./DiscoveryHoverCard";
import type {HomeTitle} from "./HomeDiscovery";
import "./HomeExperience.css";

const details=({library,entry}:HomeTitle)=>`/media/${encodeURIComponent(library.id)}?native_library=${encodeURIComponent(library.id)}&native_item=${encodeURIComponent(entry.id)}&from=home`;
const play=({library,entry}:HomeTitle)=>`/play/native/${encodeURIComponent(library.id)}/${encodeURIComponent(entry.id)}?return=%2F`;
const playable=({entry}:HomeTitle)=>entry.available&&entry.metadata.missing!==true&&entry.kind==="movie"&&entry.files.length>0;
function numeric(value:unknown){if(typeof value!=="number"&&(typeof value!=="string"||!value.trim()))return;const n=Number(value);return Number.isFinite(n)?n:undefined;}
function genres({entry}:HomeTitle){return Array.isArray(entry.metadata.genres)?[...new Set(entry.metadata.genres.filter((v):v is string=>typeof v==="string"&&!!v.trim()).map(v=>v.trim()))]:[];}
function Artwork({title,hero=false}:{title:HomeTitle;hero?:boolean}){
  const kind=["landscape","backdrop","fanart","thumb","poster"].find(kind=>title.entry.artwork.some(art=>art.kind===kind));
  const src=kind?stillArtwork(`${nativeLibraries.artworkUrl(title.library.id,title.entry.id,kind)}?v=${encodeURIComponent(nativeArtworkVersion(title.entry,kind))}`):undefined;
  const [failed,setFailed]=useState(false);
  useEffect(()=>setFailed(false),[src]);
  return src&&!failed?<img src={sizedArtwork(src,hero?1920:640)} srcSet={hero?`${sizedArtwork(src,1280)} 1280w, ${sizedArtwork(src,1920)} 1920w`:`${sizedArtwork(src,320)} 320w, ${sizedArtwork(src,480)} 480w, ${sizedArtwork(src,640)} 640w`} sizes={hero?"100vw":"(min-width: 1200px) 20vw, (min-width: 900px) 25vw, (min-width: 600px) 33vw, 45vw"} alt="" loading={hero?"eager":"lazy"} decoding="async" onError={()=>setFailed(true)}/>:<div className="pv-home-art-fallback"><Film aria-hidden="true"/><span>{title.entry.title}</span></div>;
}

export function FeaturedTitle({titles}:{titles:HomeTitle[]}){
  const title=titles.find(title=>title.entry.artwork.some(art=>["backdrop","landscape","fanart"].includes(art.kind)))??titles[0];
  if(!title)return null;
  const year=numeric(title.entry.metadata.year);
  const rating=typeof title.entry.metadata.mpaa==="string"?title.entry.metadata.mpaa.trim():"";
  const plot=mediaDescription(title.entry.metadata.plot);
  return <section className="pv-home-hero" aria-label="Featured title">
    <div className="pv-home-hero-art"><Artwork title={title} hero/></div>
    <div className="pv-home-hero-content">
      <p className="pv-home-eyebrow">Featured · {title.library.name}</p>
      <h2>{title.entry.title}</h2>
      <p className="pv-home-hero-meta">{[title.entry.kind==="series"?"Series":"Movie",year&&year>0?year:null,rating,...genres(title).slice(0,2)].filter(Boolean).join(" · ")}</p>
      {plot&&<p className="pv-home-hero-plot">{plot}</p>}
      <div className="pv-home-actions">
        {playable(title)&&<Link className="pv-home-action pv-home-action-primary" to={play(title)} aria-label={`Play ${title.entry.title}`}><Play aria-hidden="true"/>Play</Link>}
        {title.entry.kind==="series"&&title.entry.available&&title.entry.metadata.missing!==true&&<Link className="pv-home-action pv-home-action-primary" to={details(title)} aria-label={`Browse episodes of ${title.entry.title}`}><Play aria-hidden="true"/>Browse Episodes</Link>}
        <Link className="pv-home-action" to={details(title)} aria-label={`More info about ${title.entry.title}`}><Info aria-hidden="true"/>More Info</Link>
      </div>
    </div>
  </section>;
}

function LandscapeRow({label,titles}:{label:string;titles:HomeTitle[]}){
  const heading=useId(),row=useRef<HTMLDivElement>(null);
  const [edges,setEdges]=useState({left:false,right:false});
  useEffect(()=>{
    const element=row.current;if(!element)return;
    const update=()=>setEdges({left:element.scrollLeft>1,right:element.scrollLeft+element.clientWidth<element.scrollWidth-1});
    update();element.addEventListener("scroll",update);window.addEventListener("resize",update);
    const observer=typeof ResizeObserver!=="undefined"?new ResizeObserver(update):undefined;observer?.observe(element);
    return()=>{element.removeEventListener("scroll",update);window.removeEventListener("resize",update);observer?.disconnect();};
  },[titles]);
  const scroll=(direction:number)=>row.current?.scrollBy({left:row.current.clientWidth*.85*direction,behavior:window.matchMedia?.("(prefers-reduced-motion: reduce)").matches?"instant":"smooth"});
  return <section className="pv-home-row" aria-labelledby={heading}>
    <div className="pv-home-row-heading"><h2 id={heading}>{label}</h2>{(edges.left||edges.right)&&<div className="pv-home-row-arrows">
      <button aria-label={`Scroll ${label} left`} disabled={!edges.left} onClick={()=>scroll(-1)}><ChevronLeft aria-hidden="true"/></button>
      <button aria-label={`Scroll ${label} right`} disabled={!edges.right} onClick={()=>scroll(1)}><ChevronRight aria-hidden="true"/></button>
    </div>}</div>
    <div className="pv-home-landscape-track scrollbar-hidden" ref={row}>{titles.slice(0,20).map(title=><article className="pv-home-landscape-card" key={`${title.library.id}:${title.entry.id}`}>
      <DiscoveryHoverCard title={title}>
        <Link className="pv-home-card-link" to={details(title)} aria-label={`Open ${title.entry.title} in ${title.library.name}`}><div className="pv-home-landscape-art"><Artwork title={title}/></div><h3>{title.entry.title}</h3></Link>
      </DiscoveryHoverCard>
    </article>)}</div>
  </section>;
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
