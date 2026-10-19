import {settingsPages} from "../features/settings/navigation";
import ArtworkSettings from "../features/artwork/ArtworkSettings";
import BookPreferences from "../components/BookPreferences";
import UsersSection from "../components/UsersSection";
import {useIsAdmin} from "../lib/authContext";
import TranscodingSettings from "../features/settings/transcoding/TranscodingSettings";
import PlaybackPreferences from "../features/playback/components/PlaybackPreferences";
import SettingsPageFrame from "../components/SettingsPageFrame";
import ScheduledTasks from "../components/ScheduledTasks";
import PluginsPage from "../components/PluginsPage";
import ServerSettingsDashboard from "../components/ServerSettingsDashboard";
import { useEffect, useState } from "react";
import { Navigate, useLocation, useSearchParams } from "react-router-dom";
import SecuritySection from "../components/SecuritySection";
import NativeLibrariesSection, { NativeLibraryCount } from "../components/NativeLibrariesSection";
import { type SettingsSaveStatus } from "../lib/settingsSaveStatus";
import AppearanceSection from "../features/settings/appearance/AppearanceSection";
import ArtworkSourcesSection from "../features/settings/providers/ArtworkSourcesSection";
const TABS=settingsPages.filter(page=>page.id!=="");

export default function SettingsPage({previewSection}: {previewSection?: string} = {}) {
  const isAdmin=useIsAdmin();

  const [searchParams] = useSearchParams();
  const location = useLocation();
  const requestedTab = searchParams.get("tab") === "database" ? "tasks" : searchParams.get("tab");
  const section = previewSection ?? location.pathname.split("/")[2];
  const candidate = section === "database" ? "tasks" : section;
  const tab = TABS.find(section => section.id === candidate)?.id;
  const [saveStatus, setSaveStatus] = useState<SettingsSaveStatus|null>(null);

  useEffect(() => {
    const update = (event: Event) => setSaveStatus((event as CustomEvent<SettingsSaveStatus>).detail);
    window.addEventListener("posterview:settings-save", update);
    return () => window.removeEventListener("posterview:settings-save", update);
  }, []);

  useEffect(()=>{setSaveStatus(null);},[tab]);

  if (!previewSection && requestedTab && TABS.some(section => section.id === requestedTab)) return <Navigate replace to={`/settings/${requestedTab}`} />;
  if (!isAdmin && tab !== "playback" && tab !== "reading") return <Navigate replace to="/settings/playback" />;
  if (!tab) return <ServerSettingsDashboard />;
  const selectedPage=settingsPages.find(page=>page.id===tab)!;
  return <SettingsPageFrame title={selectedPage.title} description={selectedPage.description} scope={selectedPage.scope} wide={tab==="appearance"} split={tab==="appearance"} status={tab==="libraries"?<NativeLibraryCount/>:saveStatus?<span className={saveStatus==="error"?"text-danger":"text-accent"}>{saveStatus==="saving"?"Saving…":saveStatus==="saved"?"Changes saved automatically":"Settings could not be saved."}</span>:undefined}>
          {tab === "plugins" && <PluginsPage/>}
          {tab === "artwork" && <ArtworkSettings/>}
          {tab === "reading" && <BookPreferences />}
          {tab === "users" && <UsersSection />}
          {tab === "libraries" && <NativeLibrariesSection />}
          {tab === "sources" && <ArtworkSourcesSection />}
          {tab === "tasks" && <ScheduledTasks/>}
          {tab === "playback" && <PlaybackPreferences/>}
          {tab === "transcoding" && <TranscodingSettings/>}
          {tab === "appearance" && <AppearanceSection preview={!!previewSection} />}
          {tab === "security" && <SecuritySection />}
  </SettingsPageFrame>;
}
