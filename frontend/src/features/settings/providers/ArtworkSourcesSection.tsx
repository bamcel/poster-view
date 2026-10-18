import { useAutoSave } from "../../../lib/useAutoSave";
import AutoSaveStatus from "../../../components/AutoSaveStatus";
import { compactInputCls } from "../formStyles";
import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import NativeProviderCredentials from "../../../components/NativeProviderCredentials";
import { api } from "../../../api/client";
import { useToast } from "../../../lib/toast";
import ProviderConnection, { providerStatus,TestConnectionButton } from "../../../components/ProviderConnection";
import { reportSettingsSave } from "../../../lib/settingsSaveStatus";
export default function ArtworkSourcesSection() {
  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted"><p>Manage connections here. Choose providers and their priority in each library.</p><a href="/settings/libraries" className="text-accent">Manage libraries →</a></div>
      <section aria-labelledby="provider-accounts-heading" className="overflow-hidden rounded-xl border border-border bg-window"><header className="border-b border-border px-5 py-4"><h2 id="provider-accounts-heading" className="font-semibold">Accounts & API keys</h2><p className="mt-1 text-xs text-muted">Open a provider to configure or test its saved connection. Blank fields keep existing credentials.</p></header>
        <TmdbCredentialsFields />
        <ArtworkCredentialsFields />
      </section>
      <section aria-labelledby="automatic-providers-heading" className="rounded-xl border border-border bg-window p-5"><header className="mb-4"><h2 id="automatic-providers-heading" className="font-semibold">Ready to use</h2><p className="mt-1 text-xs text-muted">These sources work without an API key or account setup.</p></header><div className="grid gap-x-8 sm:grid-cols-2 xl:grid-cols-3">
        {[
          { id: "anilist", name: "AniList", description: "Anime artwork", url: "https://anilist.co" },
          { id: "anilist-manga", name: "AniList Manga", description: "Manga artwork and metadata", url: "https://anilist.co" },
          { id: "mediux", name: "MediUX", description: "Movie and TV artwork", url: "https://mediux.pro" },
          { id: "mangadex", name: "MangaDex", description: "Manga covers", url: "https://mangadex.org" },
          { id: "viz", name: "VIZ", description: "Manga covers", url: "https://www.viz.com" },
        ].map(provider => <a key={provider.id} href={provider.url} target="_blank" rel="noreferrer" className="flex items-center justify-between gap-3 border-b border-border py-4 text-sm hover:text-accent"><span><span className="font-medium">{provider.name}</span><span className="mt-1 block text-xs text-muted">{provider.description}</span></span><span aria-hidden="true" className="text-muted">↗</span></a>)}
      </div></section>

    </section>
  );
}

function TmdbCredentialsFields() {
  const client = useQueryClient();
  const settings = useQuery({ queryKey: ["artwork-settings"], queryFn: api.getArtworkSettings });
  return <CredentialConnection id="tmdb" name="TMDB" description="Movie and TV metadata" setupUrl="https://www.themoviedb.org/settings/api" configured={settings.data?.tmdb_configured} ready={settings.isSuccess} fields={[{key:"tmdb_access_token",label:"TMDB API Read Access Token or API key"}]} save={async value => { const result = await api.setArtworkSettings(value); client.setQueryData(["artwork-settings"],result); }} test={() => api.testArtworkProvider({provider:"tmdb"})}/>;
}

function CredentialConnection({id,name,description,setupUrl,configured,ready,fields,save,test,initialEmail}: {
 id:string;name:string;description:string;setupUrl:string;configured?:boolean;ready:boolean;
 fields:{key:string;label:string;optional?:boolean}[];initialEmail?:string;
 save:(value:Record<string,string>)=>Promise<void>;test:()=>Promise<{ok:boolean;message:string}>;
}) {
 const [draft,setDraft]=useState<Record<string,string>>({});
 const connection=useMutation({mutationFn:test});
 const hasSecret=fields.some(field=>field.key!=="email" && !!draft[field.key]?.trim());
 const valid=hasSecret && (!fields.some(field=>field.key==="email") || !!(draft.email ?? initialEmail)?.trim());
 const autosave=useAutoSave({value:draft,enabled:ready,save:async value=>{
   const nonempty=Object.fromEntries(Object.entries(value).filter(([,entry])=>entry.trim()).map(([key,entry])=>[key,key==="password"?entry:entry.trim()]));
   if(!Object.keys(nonempty).some(key=>key!=="email"))return;
   if(fields.some(field=>field.key==="email")){ nonempty.email = (value.email ?? initialEmail ?? "").trim(); if(!nonempty.email)return; }
   await save(nonempty);
 }});
 const dirty=hasSecret && autosave.status!=="saved";
 return <ProviderConnection id={id} name={name} description={description} setupUrl={setupUrl} status={!ready?"Configuration unavailable":providerStatus(configured,connection.isPending,connection.data,connection.error)}>
  <p className="mb-3 text-xs text-muted">Changes save automatically. Blank fields keep saved credentials.</p>
  <div className="grid gap-3 sm:grid-cols-2">{fields.map(field=><Field key={field.key} label={field.label}><input className={compactInputCls} type={field.key==="email"?"text":"password"} autoComplete="off" disabled={!ready} value={draft[field.key]??(field.key==="email"?initialEmail??"":"")} placeholder={configured && field.key!=="email"?"Leave blank to keep saved credential":""} onChange={event=>{setDraft(value=>({...value,[field.key]:event.target.value}));connection.reset();}}/></Field>)}</div>
  {hasSecret && !valid ? <p role="status" className="mt-2 text-xs text-muted">Enter your email / username to save these credentials automatically.</p> : <AutoSaveStatus {...autosave}/>}
  <div className="mt-3"><TestConnectionButton pending={connection.isPending} disabled={!configured || !ready || dirty || autosave.status==="saving" || autosave.status==="pending"} onClick={()=>connection.mutate()}/></div>
  <ProviderFeedback name={name} pending={connection.isPending} result={connection.data} error={connection.error?.message}/>
 </ProviderConnection>;
}

const ARTWORK_DATABASES = [
  { name: "posterdb", label: "ThePosterDB" },
  { name: "mangadex", label: "MangaDex" },
  { name: "viz", label: "VIZ" },
  { name: "comicvine", label: "ComicVine" },
  { name: "fanart", label: "Fanart.tv" },
  { name: "tvdb", label: "TheTVDB" },
  { name: "anilist", label: "AniList" },
  { name: "anilist-manga", label: "AniList Manga" },
  { name: "mediux", label: "MediUX" },
];

function DefaultArtworkSourceFields({ kind, names }: { kind: "poster" | "ereader"; names: string[] }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const settingsQ = useQuery({ queryKey: ["artwork-settings"], queryFn: api.getArtworkSettings });
  const saveMut = useMutation({
    mutationFn: (provider: string) => api.setArtworkSettings(
      kind === "poster" ? { default_provider: provider } : { ereader_default_provider: provider },
    ),
    onMutate: () => reportSettingsSave("saving"),
    onSuccess: (settings) => {
      queryClient.setQueryData(["artwork-settings"], settings);
      toast.push("success", `Default ${kind === "poster" ? "poster" : "eReader"} source saved.`);
      reportSettingsSave("saved");
    },
    onError: (e: Error) => {
      reportSettingsSave("error");
      queryClient.invalidateQueries({ queryKey: ["artwork-cache"] });
      toast.push("error", e.message);
    },
  });

  return (
    <label className="flex w-full flex-col gap-1 text-xs font-medium text-muted">
      Default provider
      <select
        title={kind === "poster"
          ? "Opens first whenever you select a movie, series, or collection."
          : "Opens first whenever you select book-related media."}
        className={compactInputCls}
        value={(kind === "poster" ? settingsQ.data?.default_provider : settingsQ.data?.ereader_default_provider) ?? ""}
        onChange={(event) => saveMut.mutate(event.target.value)}
        disabled={settingsQ.isLoading || saveMut.isPending}
      >
        {ARTWORK_DATABASES.filter((source) => names.includes(source.name)).map((source) => (
          <option key={source.name} value={source.name}>{source.label}</option>
        ))}
      </select>
      <AutoSaveStatus status={saveMut.isPending?"saving":saveMut.isError?"error":saveMut.isSuccess?"saved":"idle"} error={saveMut.error}/>
    </label>
  );
}

export function DefaultArtworkSourcesFields({flat=false}:{flat?:boolean}={}) {
  return <div className="grid gap-4 lg:grid-cols-2">
    {[
      { label: "Poster", kind: "poster" as const, names: ["anilist", "fanart", "mediux", "posterdb", "tvdb"] },
      { label: "eReader", kind: "ereader" as const, names: ["anilist-manga", "comicvine", "mangadex", "viz"] },
    ].map(group => <div key={group.kind} role="group" aria-labelledby={`provider-group-${group.kind}`} className={flat ? "min-w-0 border-b border-border pb-5" : "min-w-0 rounded-xl border border-border bg-surface-2 p-4"}>
      <h3 id={`provider-group-${group.kind}`} className="mb-3 text-sm font-semibold">{group.label} providers</h3>
      <DefaultArtworkSourceFields kind={group.kind} names={group.names} />
    </div>)}
  </div>;
}

function ArtworkCredentialsFields() {
 const client=useQueryClient();
 const status=useQuery({queryKey:["posterdb-status"],queryFn:api.posterdbStatus});
 const settings=useQuery({queryKey:["artwork-settings"],queryFn:api.getArtworkSettings});
 const saveArtwork=async(value:Record<string,string>)=>{const result=await api.setArtworkSettings(value);client.setQueryData(["artwork-settings"],result);void client.invalidateQueries({queryKey:["artwork-providers"]});};
 return <>
  <CredentialConnection id="posterdb" name="ThePosterDB" description="Posters" setupUrl="https://theposterdb.com/register" configured={status.data?.configured} ready={status.isSuccess} initialEmail={status.data?.email} fields={[{key:"email",label:"Email / username"},{key:"password",label:"Password"}]} save={async value=>{await api.setPosterdbCredentials(value.email,value.password);await client.invalidateQueries({queryKey:["posterdb-status"]});}} test={async()=>{const result=await api.posterdbLogin();await client.invalidateQueries({queryKey:["posterdb-status"]});return {ok:result.logged_in,message:result.message || (result.logged_in?"Logged in.":"Login failed.")};}}/>
  <CredentialConnection id="fanart" name="Fanart.tv" description="Artwork" setupUrl="https://fanart.tv/get-an-api-key/" configured={settings.data?.fanart_configured} ready={settings.isSuccess} fields={[{key:"fanart_api_key",label:"Fanart.tv API Key"}]} save={saveArtwork} test={()=>api.testArtworkProvider({provider:"fanart"})}/>
  <CredentialConnection id="tvdb" name="TheTVDB" description="TV artwork and metadata" setupUrl="https://thetvdb.com/dashboard/account/apikey" configured={settings.data?.tvdb_configured} ready={settings.isSuccess} fields={[{key:"tvdb_api_key",label:"TheTVDB API Key"},{key:"tvdb_pin",label:"TheTVDB Subscriber PIN (Optional)"}]} save={saveArtwork} test={()=>api.testArtworkProvider({provider:"tvdb"})}/>
  <CredentialConnection id="comicvine" name="ComicVine" description="Comics metadata" setupUrl="https://comicvine.gamespot.com/api/" configured={settings.data?.comicvine_configured} ready={settings.isSuccess} fields={[{key:"comicvine_api_key",label:"ComicVine API Key"}]} save={saveArtwork} test={()=>api.testArtworkProvider({provider:"comicvine"})}/>
  <NativeProviderCredentials/>
 </>;
}

function ProviderFeedback({ name, pending, result, error }: {
  name: string; pending: boolean; result?: { ok: boolean; message: string }; error?: string;
}) {
  if (!pending && !result && !error) return null;
  const failed = !pending && (Boolean(error) || result?.ok === false);
  return <p role="status" aria-live="polite" aria-atomic="true" className={`mt-3 break-words text-sm ${failed ? "text-danger" : "text-accent"}`}>
    <span className="font-medium">{name}: {pending ? "Testing connection…" : failed ? "Connection failed. " : "Connection successful. "}</span>
    {!pending && (error || result?.message)}
  </p>;
}



// ---------------------------------------------------------------------------
// Small form helpers
// ---------------------------------------------------------------------------


function Field({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-muted">{label}</span>
      {children}
    </label>
  );
}
