import {useContext} from "react";
import {useQuery} from "@tanstack/react-query";
import {apiRequest} from "../../api/client";
import type {NativeCatalogEntry} from "../../api/nativeLibraries";
import {AuthSessionContext} from "../../lib/authContext";

export interface MemberRef {library_id:string;item_id:string}
export interface CollectionMember extends MemberRef {library_name:string;entry:NativeCatalogEntry}
export interface CollectionMetadata {provider:string;provider_id:string;poster_url:string;backdrop_url:string;locks:string[]}
export interface MetadataCandidate {provider:string;provider_id:string;title:string;overview:string;poster_url:string;backdrop_url:string}
export interface MetadataPreview {metadata:MetadataCandidate;matches:CollectionMember[];unmatched:number}
export interface Collection {id:string;title:string;overview:string;ordering:"release"|"title"|"custom";revision:number;created_at:string;updated_at:string;members:CollectionMember[];metadata?:CollectionMetadata}
export type CollectionInput = Pick<Collection,"title"|"overview"|"ordering"> & {members:MemberRef[]};
const path=(id:string)=>`/collections/${encodeURIComponent(id)}`;
export const collectionsApi={
 searchMetadata:(provider:"tmdb"|"tvdb",query:string)=>apiRequest<MetadataCandidate[]>(`/collections/metadata/search?provider=${provider}&query=${encodeURIComponent(query)}`),
 previewMetadata:(id:string,input:{provider:string;provider_id:string})=>apiRequest<MetadataPreview>(`${path(id)}/metadata/preview`,{method:"POST",body:JSON.stringify({provider:input.provider,provider_id:input.provider_id})}),
 applyMetadata:(id:string,input:{revision:number;provider:string;provider_id:string;locks:string[];add_members:boolean})=>apiRequest<Collection>(`${path(id)}/metadata/apply`,{method:"POST",body:JSON.stringify(input)}),
 saveMetadataLocks:(id:string,input:{revision:number;locks:string[]})=>apiRequest<Collection>(`${path(id)}/metadata/locks`,{method:"PUT",body:JSON.stringify(input)}),
 list:(libraryId?:string)=>apiRequest<Collection[]>(`/collections${libraryId?`?library_id=${encodeURIComponent(libraryId)}`:""}`),
 get:(id:string)=>apiRequest<Collection>(path(id)),
 create:(input:CollectionInput)=>apiRequest<Collection>("/collections",{method:"POST",body:JSON.stringify(input)}),
 update:(id:string,input:CollectionInput&{revision:number})=>apiRequest<Collection>(path(id),{method:"PUT",body:JSON.stringify(input)}),
 addMembers:(id:string,input:{revision:number;members:MemberRef[]})=>apiRequest<{collection:Collection;added:number;existing:number}>(`${path(id)}/members`,{method:"POST",body:JSON.stringify(input)}),
 remove:(id:string)=>apiRequest<void>(path(id),{method:"DELETE"}),
 preferences:(libraryId:string)=>apiRequest<{group_collections:boolean}>(`/collections/preferences/${encodeURIComponent(libraryId)}`),
 setPreferences:(libraryId:string,input:{group_collections:boolean})=>apiRequest<{group_collections:boolean}>(`/collections/preferences/${encodeURIComponent(libraryId)}`,{method:"PUT",body:JSON.stringify(input)}),
};
export function useCollectionAccount(){return useContext(AuthSessionContext)?.user?.id??"local";}
export function useCollections(libraryId?:string){const user=useCollectionAccount();return useQuery({queryKey:["collections",user,"list",libraryId??"all"],queryFn:()=>collectionsApi.list(libraryId)});}
export const memberKey=(member:MemberRef)=>JSON.stringify([member.library_id,member.item_id]);
