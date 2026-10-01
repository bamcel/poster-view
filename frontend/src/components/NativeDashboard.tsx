import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { nativeLibraries } from "../api/nativeLibraries";
import NativeCatalogPanel from "./NativeCatalogPanel";

export default function NativeDashboard() {
  const client = useQueryClient();
  const libraries = useQuery({queryKey: ["native-libraries"], queryFn: nativeLibraries.list});
  const [selected, setSelected] = useState(() => localStorage.getItem("posterview.manualLibraryTab") ?? "");
  const library = libraries.data?.find(l => l.id === selected) ?? libraries.data?.[0];
  useEffect(() => { if (library) localStorage.setItem("posterview.manualLibraryTab", library.id); }, [library?.id]);
  return <div className="flex h-full min-h-0 flex-col">
    {libraries.isPending && <p role="status" className="p-5 text-muted">Loading manual libraries…</p>}
    {libraries.error && <p role="alert" className="p-5 text-danger">{libraries.error.message} <button className="underline" onClick={() => void libraries.refetch()}>Retry</button></p>}
    {libraries.data?.length === 0 && <div className="p-8 text-muted"><h2 className="text-lg text-white">No manual libraries yet</h2><p className="mt-2">Add a library in Settings → Libraries to browse your mounted media.</p><Link to="/settings" className="mt-4 inline-block text-accent underline">Open Settings</Link></div>}
    {!!libraries.data?.length && <nav aria-label="Manual libraries" className="flex shrink-0 gap-2 overflow-x-auto border-b border-edge px-5 py-3">{libraries.data.map(l => <button key={l.id} aria-pressed={library?.id === l.id} onClick={() => setSelected(l.id)} className={`shrink-0 rounded-xl border px-4 py-2 text-sm ${library?.id === l.id ? "border-accent bg-accent/10 text-accent" : "border-edge text-muted"}`}>{l.name}</button>)}</nav>}
    {library && <div className="min-h-0 flex-1"><NativeCatalogPanel key={library.id} library={library} embedded onClose={() => {}} onDeleted={() => { void client.invalidateQueries({queryKey: ["native-libraries"]}); }} /></div>}
  </div>;
}
