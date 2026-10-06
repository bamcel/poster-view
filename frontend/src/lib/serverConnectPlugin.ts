import {useQuery} from "@tanstack/react-query";
import {apiRequest} from "../api/client";
export interface PluginSettings {enabled:boolean;pinned:boolean}
export function useServerConnectPlugin(){return useQuery({queryKey:["plugin-server-connect"],queryFn:()=>apiRequest<PluginSettings>("/plugins/server-connect")});}
