import BookPreferences from "../components/BookPreferences";
import UsersSection from "../components/UsersSection";
import {useIsAdmin} from "../lib/authContext";
import TranscodingSettings from "../features/settings/transcoding/TranscodingSettings";
import PlaybackPreferences from "../features/playback/components/PlaybackPreferences";
import SettingsPageFrame from "../components/SettingsPageFrame";
import ScheduledTasks from "../components/ScheduledTasks";
import { useNavigate as useLibraryNavigate } from "../lib/libraryNavigation";
import PluginsPage from "../components/PluginsPage";
import ServerSettingsDashboard from "../components/ServerSettingsDashboard";
import { useEffect, useState, type ReactNode } from "react";
import { Navigate, useLocation, useSearchParams } from "react-router-dom";
import { KeyRound, Image as ImageIcon, Server as ServerIcon, Database, Palette, HardDrive } from "lucide-react";
import SecuritySection from "../components/SecuritySection";
import NativeLibrariesSection, { NativeLibraryCount } from "../components/NativeLibrariesSection";
import { type SettingsSaveStatus } from "../lib/settingsSaveStatus";
import AppearanceSection from "../features/settings/appearance/AppearanceSection";
import ArtworkSourcesSection from "../features/settings/providers/ArtworkSourcesSection";
type SettingsTab = "reading" | "users" | "playback" | "transcoding" | "plugins" | "artwork" | "libraries" | "sources" | "tasks" | "appearance" | "security";


const TABS: { id: SettingsTab; label: string; icon: ReactNode }[] = [
  {id:"reading",label:"Reading",icon:<ServerIcon className="size-4"/>},
  {id:"users",label:"Users",icon:<KeyRound className="size-4"/>},
  {id:"playback",label:"Playback",icon:<ServerIcon className="size-4"/>},
  {id:"transcoding",label:"Transcoding",icon:<ServerIcon className="size-4"/>},
  { id: "artwork", label: "Artwork", icon: <ImageIcon className="size-4" /> },
  { id: "plugins", label: "Plugins", icon: <ServerIcon className="size-4" /> },
  { id: "libraries", label: "Libraries", icon: <HardDrive className="size-4" /> },
  { id: "sources", label: "Search Providers", icon: <ImageIcon className="size-4" /> },
  { id: "tasks", label: "Scheduled Tasks", icon: <Database className="size-4" /> },
  { id: "appearance", label: "Appearance", icon: <Palette className="size-4" /> },
  { id: "security", label: "Privacy / Security", icon: <KeyRound className="size-4" /> },
];

export default function SettingsPage({previewSection}: {previewSection?: string} = {}) {
  const isAdmin=useIsAdmin();
  const navigate=useLibraryNavigate();
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const requestedTab = searchParams.get("tab") === "database" ? "tasks" : searchParams.get("tab");
  const section = previewSection ?? location.pathname.split("/")[2];
  const candidate = section === "database" ? "tasks" : section;
  const tab = TABS.find(section => section.id === candidate)?.id;
  const [artworkOpen,setArtworkOpen]=useState(false);
  const [saveStatus, setSaveStatus] = useState<SettingsSaveStatus>("saved");

  useEffect(() => {
    const update = (event: Event) => setSaveStatus((event as CustomEvent<SettingsSaveStatus>).detail);
    window.addEventListener("posterview:settings-save", update);
    return () => window.removeEventListener("posterview:settings-save", update);
  }, []);

  useEffect(()=>{setSaveStatus("saved");},[tab]);

  if (!previewSection && requestedTab && TABS.some(section => section.id === requestedTab)) return <Navigate replace to={`/settings/${requestedTab}`} />;
  if (!isAdmin && tab !== "playback" && tab !== "reading") return <Navigate replace to="/settings/playback" />;
  if (!tab) return <ServerSettingsDashboard />;
  const descriptions:Record<SettingsTab,string>={reading:"Set your personal reading and book display preferences.",users:"Create accounts and control library access and content ratings.",playback:"Set audio, subtitle, resume, and watching preferences.",transcoding:"Choose how temporary playback streams adapt to your browser and connection.",plugins:"Choose a plugin to manage its features and settings.",artwork:"Configure artwork browsing and editing tools.",libraries:"Manage media folders, metadata providers, and artwork.",sources:"Configure provider accounts and test their connections.",tasks:"Review cleanup and schedule application maintenance.",appearance:"Customize your theme, layout, and backgrounds.",security:"Manage sign-in, session, and privacy preferences."};
  return <SettingsPageFrame title={TABS.find(section=>section.id===tab)!.label} description={descriptions[tab]} wide={tab==="appearance"} split={tab==="appearance"} status={tab==="libraries"?<NativeLibraryCount/>:saveStatus!=="saved"?<span className={saveStatus==="error"?"text-danger":"text-accent"}>{saveStatus==="saving"?"Savingâ€¦":"Settings could not be saved."}</span>:undefined}>
          {(tab === "plugins" || tab === "artwork") && <PluginsPage artworkOpen={tab === "artwork" || artworkOpen} onArtworkOpen={()=>setArtworkOpen(true)} onClose={()=>{setArtworkOpen(false);if(tab === "artwork") navigate("/settings/plugins");}}/>}
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
