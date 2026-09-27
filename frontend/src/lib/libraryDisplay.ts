import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { readerRequest } from "./reader";
const queryKey = ["library-display"];
export type ColoredEffect = "off" | "shimmer" | "badge" | "both";
export function toggleColoredEffect(current: ColoredEffect, effect: "shimmer" | "badge"): ColoredEffect {
  const shimmer = current === "shimmer" || current === "both";
  const badge = current === "badge" || current === "both";
  const nextShimmer = effect === "shimmer" ? !shimmer : shimmer;
  const nextBadge = effect === "badge" ? !badge : badge;
  return nextShimmer && nextBadge ? "both" : nextShimmer ? "shimmer" : nextBadge ? "badge" : "off";
}
interface Preferences { tracking_overlays: boolean; reading_threshold: number; finished_threshold: number; colored_effect?: ColoredEffect; colored_title?: boolean }
export function useTrackingOverlays(enabled = true) {
  const client = useQueryClient();
  const query = useQuery({ queryKey, enabled, queryFn: () => readerRequest<Preferences>("/api/library-display"), refetchOnWindowFocus: "always" });
  const save = useMutation({
    scope: { id: "library-display-save" },
    mutationFn: (value: Partial<Preferences>) => readerRequest<Preferences>("/api/library-display", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tracking_overlays: true, reading_threshold: 5, finished_threshold: 95, ...client.getQueryData<Preferences>(queryKey), ...value }) }),
    onSuccess: async (settings) => { await client.cancelQueries({ queryKey }); client.setQueryData(queryKey, settings); void client.invalidateQueries({ queryKey: ["book-info"] }); },
  });
  return [query.data?.tracking_overlays ?? true, (value: boolean) => save.mutate({ tracking_overlays: value }), {
    readingThreshold: query.data?.reading_threshold ?? 5,
    coloredEffect: query.data?.colored_effect ?? "off",
    coloredTitle: query.data?.colored_title ?? false,
    setColoredTitle: (enabled: boolean) => save.mutate({ colored_title: enabled }),
    setColoredEffect: (effect: ColoredEffect) => save.mutate({ colored_effect: effect }),
    toggleColoredEffect: (effect: "shimmer" | "badge") => save.mutate({ colored_effect: toggleColoredEffect(query.data?.colored_effect ?? "off", effect) }),
    finishedThreshold: query.data?.finished_threshold ?? 95,
    saveThresholds: (reading: number, finished: number) => save.mutate({ reading_threshold: reading, finished_threshold: finished }),
    busy: query.isPending || save.isPending,
    error: save.isError ? "Could not save preferences. Please try again." : query.isError ? "Could not load preferences." : undefined,
  }] as const;
}
