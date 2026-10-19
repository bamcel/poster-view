import {useIsAdmin} from "../lib/authContext";
import OmdbPlugin from "./OmdbPlugin";
import YtdlPlugin from "../features/settings/ytdl/YtdlPlugin";
import VirtualTvPlugin from "../features/virtual-tv/VirtualTvPlugin";
import PairwisePlugin from "../features/pairwise/PairwisePlugin";
import AniDBPlugin from "./AniDBPlugin";
export default function PluginsPage(){
 const isAdmin=useIsAdmin();
 return isAdmin?<div className="grid grid-cols-1 items-stretch gap-5 sm:grid-cols-2 xl:grid-cols-3"><AniDBPlugin/><OmdbPlugin/><YtdlPlugin/><VirtualTvPlugin/><PairwisePlugin/></div>:null;
}
