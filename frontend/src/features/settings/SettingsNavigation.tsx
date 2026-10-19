import {NavLink} from "react-router-dom";
import {settingsPath,visibleSettingsPages} from "./navigation";
export default function SettingsNavigation({admin,previewPath}:{admin:boolean;previewPath?:string}){
 const pages=visibleSettingsPages(admin),groups=[...new Set(pages.map(page=>page.group))];
 return <nav aria-label="Settings sections">{groups.map(group=><section key={group}><h2 className="mb-1 mt-5 px-3 text-[10px] font-semibold uppercase tracking-[.14em] text-faint">{group}</h2>{pages.filter(page=>page.group===group).map(page=><NavLink key={page.id} to={settingsPath(page.id)} end className={({isActive})=>`flex min-h-9 items-center gap-3 rounded-lg px-3 py-2 text-sm ${(previewPath?previewPath===settingsPath(page.id):isActive)?"bg-elevated text-white shadow-[inset_3px_0_0_var(--color-sidebar-accent)]":"text-muted hover:bg-input-hover hover:text-white"}`}><page.icon className="size-[18px] shrink-0"/><span>{page.title}</span></NavLink>)}</section>)}</nav>;
}
