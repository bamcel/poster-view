import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { readerRequest } from "./reader";
const queryKey = ["library-display"];
interface Preferences { tracking_overlays: boolean; reading_threshold: number; finished_threshold: number }
export function useTrackingOverlays() {
  const client = useQueryClient();
  const query = useQuery({ queryKey, queryFn: () => readerRequest<Preferences>("/api/library-display"), refetchOnWindowFocus: "always" });
  const save = useMutation({
    mutationFn: (value: Partial<Preferences>) => readerRequest<Preferences>("/api/library-display", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tracking_overlays: true, reading_threshold: 2, finished_threshold: 98, ...query.data, ...value }) }),
    onSuccess: async (settings) => { await client.cancelQueries({ queryKey }); client.setQueryData(queryKey, settings); void client.invalidateQueries({ queryKey: ["book-info"] }); },
  });
  return [query.data?.tracking_overlays ?? true, (value: boolean) => save.mutate({ tracking_overlays: value }), {
    readingThreshold: query.data?.reading_threshold ?? 2,
    finishedThreshold: query.data?.finished_threshold ?? 98,
    saveThresholds: (reading: number, finished: number) => save.mutate({ reading_threshold: reading, finished_threshold: finished }),
    busy: query.isPending || save.isPending,
    error: save.isError ? "Could not save preferences. Please try again." : query.isError ? "Could not load preferences." : undefined,
  }] as const;
}
