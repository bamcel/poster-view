import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { useSearchParams } from "../lib/libraryNavigation";
import { nativeLibraries } from "../api/nativeLibraries";
import NativeLibraryBrowser from "./NativeLibraryBrowser";

export default function NativeDashboard() {
  const libraries = useQuery({
    queryKey: ["native-libraries"],
    queryFn: nativeLibraries.list,
  });
  const [params, setParams] = useSearchParams();
  const [selected, setSelected] = useState(
    () => localStorage.getItem("posterview.manualLibraryTab") ?? "",
  );
  const library =
    libraries.data?.find(
      (l) => l.id === (params.get("native_library") ?? selected),
    ) ?? libraries.data?.[0];
  useEffect(() => {
    if (library)
      localStorage.setItem("posterview.manualLibraryTab", library.id);
  }, [library?.id]);
  return (
    <div className="flex h-full min-h-0 flex-col">
      {libraries.isPending && (
        <p role="status" className="p-5 text-muted">
          Loading manual libraries…
        </p>
      )}
      {libraries.error && (
        <p role="alert" className="p-5 text-danger">
          {libraries.error.message}{" "}
          <button
            className="underline"
            onClick={() => void libraries.refetch()}
          >
            Retry
          </button>
        </p>
      )}
      {libraries.data?.length === 0 && (
        <div className="p-8 text-muted">
          <h2 className="text-lg text-white">No manual libraries yet</h2>
          <p className="mt-2">
            Add a library in Settings → Libraries to browse your mounted media.
          </p>
          <Link
            to="/settings"
            className="mt-4 inline-block text-accent underline"
          >
            Open Settings
          </Link>
        </div>
      )}
      {!!libraries.data?.length && !params.has("native_item") && (
        <nav
          aria-label="Manual libraries"
          className="relative z-10 flex shrink-0 gap-1 overflow-x-auto border-b border-border px-4 pt-0 sm:px-6 md:pt-[75px] lg:px-8"
        >
          {libraries.data.map((l) => (
            <button
              key={l.id}
              aria-pressed={library?.id === l.id}
              onClick={() => {
                setSelected(l.id);
                setParams((previous) => {
                  const next = new URLSearchParams(previous);
                  next.set("native_library", l.id);
                  next.delete("native_item");
                  return next;
                });
              }}
              className={`min-h-11 max-w-64 shrink-0 truncate border-b-2 px-4 py-2 text-sm font-medium transition-colors ${library?.id === l.id ? "border-accent text-white" : "border-transparent text-muted hover:text-white"}`}
            >
              {l.name}
            </button>
          ))}
        </nav>
      )}
      {library && (
        <div className="min-h-0 flex-1">
          <NativeLibraryBrowser key={library.id} library={library} />
        </div>
      )}
    </div>
  );
}
