import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { readerRequest } from "./reader";
const queryKey = ["library-display"];
interface Preferences { tracking_overlays: boolean }
export function useTrackingOverlays() {
  const client = useQueryClient();
  const query = useQuery({ queryKey, queryFn: () => readerRequest<Preferences>("/api/library-display"), refetchOnWindowFocus: "always" });
  const save = useMutation({
    mutationFn: (value: boolean) => readerRequest<Preferences>("/api/library-display", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tracking_overlays: value }) }),
    onSuccess: async (settings) => { await client.cancelQueries({ queryKey }); client.setQueryData(queryKey, settings); },
  });
  return [query.data?.tracking_overlays ?? true, save.mutate, {
    busy: query.isPending || save.isPending,
    error: save.isError ? "Could not save preferences. Please try again." : query.isError ? "Could not load preferences." : undefined,
  }] as const;
}
