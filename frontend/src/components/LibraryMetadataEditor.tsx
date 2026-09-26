import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { MediaItem, NfoMetadata } from "../types";
import MetadataEditorModal from "./MetadataEditorModal";
import VideoMetadataEditor from "./VideoMetadataEditor";

export default function LibraryMetadataEditor({ serverId, item, onClose }: { serverId: number; item: MediaItem; onClose: () => void }) {
  return createPortal(item.type === "movie" || item.type === "show"
    ? <VideoMetadataEditor serverId={serverId} itemId={item.id} onClose={onClose} />
    : <BookEditor serverId={serverId} item={item} onClose={onClose} />, document.body);
}
function BookEditor({ serverId, item, onClose }: { serverId: number; item: MediaItem; onClose: () => void }) {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["nfo-metadata", serverId, item.id], queryFn: () => api.getNfoMetadata(serverId, item.id), retry: false });
  const save = useMutation({
    mutationFn: (fields: NfoMetadata) => api.updateNfoMetadata(serverId, item.id, fields),
    onSuccess: (fields) => {
      client.setQueryData(["nfo-metadata", serverId, item.id], fields);
      void client.invalidateQueries({ queryKey: ["book-info"] });
      void client.invalidateQueries({ queryKey: ["item-detail", serverId, item.id] });
      onClose();
    },
  });
  if (query.data) return <MetadataEditorModal metadata={query.data} saving={save.isPending} error={save.error?.message} onClose={onClose} onSave={fields => save.mutate(fields)} />;
  return <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4">
    <section role="dialog" aria-modal="true" aria-label="Edit Metadata" className="w-full max-w-lg rounded-2xl border border-border bg-sidebar p-6">
      <h2 className="text-lg font-semibold">Edit Metadata</h2>
      <p role={query.isError ? "alert" : "status"} className="my-4 text-sm text-muted">{query.isPending ? "Loading metadata…" : query.error?.message ?? "No editable local metadata is available for this title."}</p>
      <button autoFocus type="button" onClick={onClose} className="rounded-lg border border-border px-4 py-2">Close</button>
    </section>
  </div>;
}
