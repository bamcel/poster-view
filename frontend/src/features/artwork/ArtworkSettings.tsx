import {Switch} from "../../components/ui";
import {useMutation,useQueryClient} from "@tanstack/react-query";
import {Link} from "react-router-dom";
import {apiRequest} from "../../api/client";
import {useArtworkPreferences,type ArtworkPreferencesSettings} from "./preferences";
import {DefaultArtworkSourcesFields} from "../settings/providers/ArtworkSourcesSection";
import {SettingsPanel,SettingRow,SETTINGS_BUTTON} from "../../components/SettingsPageFrame";
import {ArtworkHistoryGrid} from "./ArtworkHistory";
export default function ArtworkSettings(){
 const settings=useArtworkPreferences(),client=useQueryClient();
 const save=useMutation({mutationFn:(value:ArtworkPreferencesSettings)=>apiRequest<ArtworkPreferencesSettings>("/artwork/preferences",{method:"PUT",body:JSON.stringify(value)}),onSuccess:value=>client.setQueryData(["plugin-artwork"],value)});
 return <div className="w-full space-y-5">{settings.isPending&&<p role="status">Loading artwork settings…</p>}{(settings.error||save.error)&&<p role="alert">{String(settings.error||save.error)}</p>}{settings.data&&<SettingsPanel title="Artwork tools" description="Changes save automatically. Automatic fetching applies to library scans and generated episode artwork. Manual artwork tools and existing images remain available.">{([['enabled','Automatically fetch artwork'],['poster_edit','Enable PosterEdit'],['backdrop_edit','Enable BackdropEdit']] as const).map(([key,label])=><SettingRow key={key} label={label}><Switch label={label} checked={settings.data![key]} disabled={save.isPending} onChange={()=>save.mutate({...settings.data!,[key]:!settings.data![key]})}/></SettingRow>)}</SettingsPanel>}<SettingsPanel title="Default artwork providers" description="These defaults apply to artwork tools. Library-specific choices remain in each library."><DefaultArtworkSourcesFields flat/></SettingsPanel>{save.isSuccess&&!save.isPending&&<p role="status" className="text-xs text-muted">Changes saved automatically</p>}{save.isPending&&<p role="status" className="text-xs text-muted">Saving changes…</p>}<SettingsPanel title="Artwork History"><ArtworkHistoryGrid/></SettingsPanel><Link className={SETTINGS_BUTTON} to="/settings/sources">Manage metadata & artwork providers</Link></div>;
}
