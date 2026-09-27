import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "../api/client";
import type { Library } from "../types";
import { reportSettingsSave } from "../lib/settingsSaveStatus";
export default function LibraryTypeSetting({ serverId, library }: { serverId: number; library: Library }) {
  const client = useQueryClient();
  const save = useMutation({
    mutationFn: (anime: boolean) => apiRequest(`/servers/${serverId}/libraries/${encodeURIComponent(library.id)}/anime`, { method: "PUT", body: JSON.stringify({ anime }) }),
    onMutate: () => reportSettingsSave("saving"),
    onSuccess: async () => {
      await Promise.all([["library-visibility", serverId], ["libraries", serverId], ["item-detail", serverId], ["series-credits", serverId]].map(queryKey => client.invalidateQueries({ queryKey })));
      reportSettingsSave("saved");
    },
    onError: () => reportSettingsSave("error"),
  });
  if (!["show", "movie", "other"].includes(library.type)) return null;
  return <div className="min-w-0">
    <label className="block text-xs text-muted">PosterView library type
      <select aria-label={`Library type for ${library.title}`} className="mt-1 w-full rounded-lg border border-border bg-input px-2 py-1.5 text-sm" value={library.anime ? "anime" : "standard"} disabled={save.isPending} onChange={event => save.mutate(event.target.value === "anime")}>
        <option value="standard">{library.type === "movie" ? "Movies" : library.type === "show" ? "TV Series" : "Server default"}</option>
        <option value="anime">Anime</option>
      </select>
    </label>
    {save.isPending && <p role="status" className="mt-1 text-xs text-muted">Indexing library titles…</p>}
    {save.error && <p role="alert" className="mt-1 text-xs text-danger">{save.error.message}</p>}
  </div>;
}
