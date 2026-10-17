import {BookOpen,Database,HardDrive,Image,LayoutDashboard,Palette,Play,Plug,Shield,Users} from "lucide-react";
export const settingsPages=[
 {id:"",title:"Overview",group:"Overview",scope:"Server-wide",description:"Server health, current activity, and items needing attention.",icon:LayoutDashboard,admin:true,keywords:"dashboard status downloads scans"},
 {id:"playback",title:"Playback",group:"Your preferences",scope:"Your profile",description:"Choose audio, subtitles, and watching preferences.",icon:Play,admin:false,keywords:"language resume tracks skip"},
 {id:"reading",title:"Reading",group:"Your preferences",scope:"Your profile",description:"Choose reading status and book display preferences.",icon:BookOpen,admin:false,keywords:"books badges colored editions"},
 {id:"libraries",title:"Libraries",group:"Media & features",scope:"Server-wide",description:"Manage media folders, metadata selection, and library artwork.",icon:HardDrive,admin:true,keywords:"folders scan movies tv anime youtube books"},
 {id:"sources",title:"Metadata & artwork providers",group:"Media & features",scope:"Server-wide",description:"Manage provider credentials and test connections. Choose provider priority in each library.",icon:Image,admin:true,keywords:"search api keys tmdb tvdb fanart comicvine anilist"},
 {id:"plugins",title:"Plugins",group:"Media & features",scope:"Server-wide",description:"Enable features and manage their configuration.",icon:Plug,admin:true,keywords:"ytdl youtube virtual tv artwork anidb omdb"},
 {id:"artwork",title:"Artwork",group:"Media & features",scope:"Server-wide",description:"Configure artwork tools and default provider choices.",icon:Image,admin:true,pinned:true,keywords:"poster backdrop edit"},
 {id:"users",title:"Users & access",group:"Administration",scope:"Server-wide",description:"Manage accounts, roles, library access, and content ratings.",icon:Users,admin:true,keywords:"permissions password accounts"},
 {id:"transcoding",title:"Playback & transcoding",group:"Administration",scope:"Server-wide",description:"Configure playback delivery, hardware acceleration, and temporary stream resources.",icon:Play,admin:true,keywords:"gpu nvenc qsv vaapi encoding bandwidth"},
 {id:"tasks",title:"Maintenance",group:"Administration",scope:"Server-wide",description:"Schedule maintenance, review cleanup, and troubleshoot cached data.",icon:Database,admin:true,keywords:"scheduled tasks cleanup cache troubleshooting"},
 {id:"appearance",title:"Appearance",group:"Administration",scope:"Server-wide",description:"Customize the shared theme, backgrounds, and panels.",icon:Palette,admin:true,keywords:"colors transparency blur theme"},
 {id:"security",title:"Security",group:"Administration",scope:"Server & browser",description:"Manage server sessions, network access, and browser sign-in preferences.",icon:Shield,admin:true,keywords:"privacy login authentication password idle"},
] as const;
export type SettingsPageId=typeof settingsPages[number]["id"];
export const settingsPath=(id:string)=>`/settings${id?`/${id}`:""}`;
export function visibleSettingsPages(admin:boolean,pinned=false){return settingsPages.filter(page=>(admin||!page.admin)&&(!("pinned" in page)||pinned));}
export function searchSettings(query:string,admin:boolean){const words=query.trim().toLowerCase().split(/\s+/);return settingsPages.filter(page=>(admin||!page.admin)&&words.every(word=>`${page.title} ${page.group} ${page.description} ${page.keywords}`.toLowerCase().includes(word)));}
