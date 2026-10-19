import {useIsAdmin} from "../../lib/authContext";
import {useQuery} from "@tanstack/react-query";
import {apiRequest} from "../../api/client";
export interface ArtworkPreferencesSettings {enabled:boolean;pinned:boolean;poster_edit:boolean;backdrop_edit:boolean}
export function useArtworkPreferences(){const isAdmin=useIsAdmin();return useQuery({enabled:isAdmin,queryKey:["plugin-artwork"],queryFn:()=>apiRequest<ArtworkPreferencesSettings>("/artwork/preferences")});}
