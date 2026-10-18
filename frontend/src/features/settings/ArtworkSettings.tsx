import {Switch} from "../../components/ui";
import {useMutation,useQueryClient} from "@tanstack/react-query";
import {Link} from "react-router-dom";
import {apiRequest} from "../../api/client";
import {useArtworkPlugin,type ArtworkPluginSettings} from "../../lib/artworkPlugin";
import {DefaultArtworkSourcesFields} from "./providers/ArtworkSourcesSection";
import {SettingsPanel,SettingRow,SETTINGS_BUTTON} from "../../components/SettingsPageFrame";
export default function ArtworkSettings(){
 const settings=useArtworkPlugin(),client=useQueryClient();
 const save=useMutation({mutationFn:(value:ArtworkPluginSettings)=>apiRequest<ArtworkPluginSettings>("/plugins/artwork",{method:"PUT",body:JSON.stringify(value)}),onSuccess:value=>client.setQueryData(["plugin-artwork"],value)});
 return <div className="w-full space-y-5">{settings.isPending&&<p role="status">Loading artwork settings…</p>}{(settings.error||save.error)&&<p role="alert">{String(settings.error||save.error)}</p>}{settings.data&&<SettingsPanel title="Artwork tools" description="Changes save automatically. Existing artwork remains visible when tools are disabled.">{([['enabled','Enable artwork'],['pinned','Pin Artwork to settings'],['poster_edit','Enable PosterEdit'],['backdrop_edit','Enable BackdropEdit']] as const).map(([key,label])=><SettingRow key={key} label={label}><Switch label={label} checked={settings.data![key]} disabled={save.isPending} onChange={()=>save.mutate({...settings.data!,[key]:!settings.data![key]})}/></SettingRow>)}</SettingsPanel>}<SettingsPanel title="Default artwork providers" description="These defaults apply to artwork tools. Library-specific choices remain in each library."><DefaultArtworkSourcesFields flat/></SettingsPanel>{save.isSuccess&&!save.isPending&&<p role="status" className="text-xs text-muted">Changes saved automatically</p>}{save.isPending&&<p role="status" className="text-xs text-muted">Saving changes…</p>}<Link className={SETTINGS_BUTTON} to="/settings/sources">Manage metadata & artwork providers</Link></div>;
}
