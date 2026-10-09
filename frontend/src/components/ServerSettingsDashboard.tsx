import {useQueries, useQuery} from "@tanstack/react-query";
import {Link} from "react-router-dom";
import {Server, Activity, AlertCircle, HardDrive} from "lucide-react";
import {api, apiRequest} from "../api/client";
import {nativeLibraries} from "../api/nativeLibraries";
import NativeScanProgress from "./NativeScanProgress";
import ActivityStatus from "./ActivityStatus";

export default function ServerSettingsDashboard() {
 const info=useQuery({queryKey:["server-runtime-status"],queryFn:()=>apiRequest<{name:string;version:string;backend:string;data_dir:string}>("/status"),refetchInterval:30_000});
 const libraries=useQuery({queryKey:["native-libraries"],queryFn:nativeLibraries.list});
 const servers=useQuery({queryKey:["servers"],queryFn:api.listServers});
 const scans=useQueries({queries:(libraries.data??[]).map(l=>({queryKey:["native-scan",l.id],queryFn:()=>nativeLibraries.status(l.id),refetchInterval:5000}))});
 const syncs=useQueries({queries:(libraries.data??[]).map(l=>({queryKey:["native-sync",l.id],queryFn:()=>nativeLibraries.syncStatus(l.id),enabled:!!l.options?.server_sync?.enabled,refetchInterval:5000}))});
 const notices=(libraries.data??[]).flatMap((l,i)=>[...(scans[i]?.data?.warnings??[]),...(syncs[i]?.data?.notices??[])].map(message=>({library:l.name,message})));
 const panel="rounded-xl bg-window p-5";
 return <div className="h-full overflow-y-auto p-4 sm:p-6 lg:p-8"><h1 className="mb-6 text-2xl font-semibold">Dashboard</h1><div className="grid gap-6 lg:grid-cols-2">
 <section className={panel}><h2 className="mb-4 flex items-center gap-2 text-lg font-semibold"><Server className="size-5"/>PosterView Server</h2>{info.isPending&&<p role="status">Loading server information…</p>}{info.error&&<p role="alert" className="text-danger">{info.error.message}</p>}{info.data&&<dl className="space-y-3 text-sm"><div><dt className="text-muted">Version</dt><dd>{info.data.version}</dd></div><div><dt className="text-muted">Access address</dt><dd className="break-all">{window.location.origin}</dd></div><div><dt className="text-muted">Application data</dt><dd className="break-all">{info.data.data_dir}</dd></div></dl>}<div className="mt-5 flex flex-wrap gap-3 text-sm"><Link to="/settings/libraries" className="rounded-full bg-elevated px-4 py-2">{libraries.data?.length??0} libraries</Link><Link to="/settings/servers" className="rounded-full bg-elevated px-4 py-2">{servers.data?.length??0} integrations</Link></div></section>
 <section className={panel}><h2 className="mb-4 flex items-center gap-2 text-lg font-semibold"><AlertCircle className="size-5"/>Notices</h2><div className="max-h-80 overflow-y-auto">{!notices.length?<p className="text-sm text-muted">No library notices reported.</p>:notices.map((notice,i)=><div key={i} className="border-b border-border py-3 text-sm"><p className="font-semibold">{notice.library}</p><p className="mt-1 text-muted">{notice.message}</p></div>)}</div></section>
 <section className={`${panel} lg:col-span-2`}><h2 className="mb-4 flex items-center gap-2 text-lg font-semibold"><Activity className="size-5"/>Library activity</h2>{libraries.error&&<p role="alert" className="text-danger">{libraries.error.message}</p>}{libraries.isPending&&<p role="status">Loading libraries…</p>}{libraries.data?.length===0&&<Link to="/settings/libraries" className="text-accent">Add your first library</Link>}<div className="grid gap-4 sm:grid-cols-2">{libraries.data?.map((library,i)=><div key={library.id} className="rounded-lg bg-sidebar p-4"><h3 className="mb-3 flex items-center gap-2 font-semibold"><HardDrive className="size-4"/>{library.name}</h3>{scans[i]?.data&&<NativeScanProgress status={scans[i].data!} compact/>}{syncs[i]?.data&&<p className="mt-2 text-xs text-muted">Sync: {syncs[i].data!.status} · {syncs[i].data!.pending} pending · {syncs[i].data!.failed} failed</p>}{scans[i]?.error&&<p className="text-xs text-danger">{scans[i].error!.message}</p>}</div>)}</div></section>
 <div className="lg:col-span-2"><ActivityStatus libraries={libraries.data??[]}/></div>
 </div></div>;
}
