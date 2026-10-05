import {useQuery} from "@tanstack/react-query";
import {apiRequest} from "../api/client";
export interface ArtworkPluginSettings {enabled:boolean;pinned:boolean;poster_edit:boolean;backdrop_edit:boolean}
export function useArtworkPlugin(){return useQuery({queryKey:["plugin-artwork"],queryFn:()=>apiRequest<ArtworkPluginSettings>("/plugins/artwork")});}
