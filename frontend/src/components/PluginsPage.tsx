import {useIsAdmin} from "../lib/authContext";
import OmdbPlugin from "./OmdbPlugin";
import YtdlPlugin from "../features/settings/ytdl/YtdlPlugin";
import VirtualTvPlugin from "../features/virtual-tv/VirtualTvPlugin";
import PairwisePlugin from "../features/pairwise/PairwisePlugin";
import AniDBPlugin from "./AniDBPlugin";
import PluginCard from "./PluginCard";
import {Link} from "../lib/libraryNavigation";
import {Images} from "lucide-react";
import {useArtworkPlugin,type ArtworkPluginSettings} from "../lib/artworkPlugin";
import {useMutation,useQueryClient} from "@tanstack/react-query";
import PopupPage from "./PopupPage";
import {ACTION_BUTTON} from "./ui";
import {apiRequest} from "../api/client";
import {DefaultArtworkSourcesFields} from "../features/settings/providers/ArtworkSourcesSection";
type PluginPageProps={onClose:()=>void;artworkOpen?:boolean;onArtworkOpen:()=>void};
export default function PluginsPage(props:PluginPageProps){
 const isAdmin=useIsAdmin();
 return isAdmin?<AdminPluginsPage {...props}/>:null;
}
function AdminPluginsPage({onClose,artworkOpen=false,onArtworkOpen}:{onClose:()=>void;artworkOpen?:boolean;onArtworkOpen:()=>void}){
 const artwork=useArtworkPlugin();
 return <div className="grid grid-cols-1 items-stretch gap-5 sm:grid-cols-2 xl:grid-cols-3"><PluginCard title="Artwork" description="Browse, upload, remove, and edit artwork with PosterEdit and BackdropEdit." coverSrc="/plugins/artwork-cover.svg" branding={<Images className="size-10 text-accent"/>} status={<><span>Built-in</span><span className="rounded-full border border-border px-2 py-1">{artwork.data?artwork.data.enabled?"Enabled":"Disabled":"Loading…"}</span></>} onClick={onArtworkOpen}/><AniDBPlugin/><OmdbPlugin/><YtdlPlugin/><VirtualTvPlugin/><PairwisePlugin/>{artworkOpen&&<ArtworkPopup onClose={onClose}/>}</div>;
}

export function ArtworkPopup(props:{onClose:()=>void}){
 const isAdmin=useIsAdmin();
 return isAdmin?<AdminArtworkPopup {...props}/>:null;
}
function AdminArtworkPopup({onClose}:{onClose:()=>void}){
 const settings=useArtworkPlugin();const client=useQueryClient();
 const save=useMutation({mutationFn:(value:ArtworkPluginSettings)=>apiRequest<ArtworkPluginSettings>("/plugins/artwork",{method:"PUT",body:JSON.stringify(value)}),onSuccess:value=>client.setQueryData(["plugin-artwork"],value)});

 return <PopupPage title="Artwork" ariaLabel="Artwork configuration" closeLabel="Close Artwork" onClose={onClose} footer={<button className={ACTION_BUTTON} onClick={onClose}>Done</button>}>{settings.data&&<div className="space-y-5">{([['enabled','Enable Artwork'],['pinned','Pin to Settings'],['poster_edit','Enable PosterEdit'],['backdrop_edit','Enable BackdropEdit']] as const).map(([key,label])=><label key={key} className="flex items-center justify-between text-sm"><span>{label}</span><input type="checkbox" role="switch" aria-label={label} checked={settings.data![key]} disabled={save.isPending} onChange={event=>save.mutate({...settings.data!,[key]:event.target.checked})} className="size-5 accent-accent"/></label>)}<p className="border-b border-border pb-5 text-xs text-muted">Disabling hides artwork tools and pauses automatic artwork downloads. Existing artwork remains visible and metadata fetching continues.</p><DefaultArtworkSourcesFields flat/><Link to="/settings/sources" onClick={onClose} className="inline-block rounded-full border border-border px-4 py-2 text-sm">Manage metadata & artwork providers</Link></div>}{(settings.error||save.error)&&<p role="alert" className="text-danger">{(settings.error||save.error)?.message}</p>}</PopupPage>;
}
