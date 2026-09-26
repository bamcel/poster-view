import { useContext } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "../api/client";
import { AuthSessionContext } from "./authContext";

export interface CastPreferences { show: boolean; hide_crew: boolean; mode: "both" | "original" | "dub"; language: string }
export const defaultCastPreferences: CastPreferences = { show: true, hide_crew: false, mode: "both", language: "system" };
export function systemCastLanguage() {
  try { return new Intl.Locale(navigator.languages?.[0] || navigator.language || "en").language; } catch { return "en"; }
}
export function useCastPreferences() {
  const session = useContext(AuthSessionContext);
  const key = ["cast-preferences", session?.username ?? "local"];
  const client = useQueryClient();
  const query = useQuery({ queryKey: key, queryFn: () => apiRequest<CastPreferences>("/credits/preferences"), refetchOnWindowFocus: "always" });
  const mutation = useMutation({
    scope: { id: "cast-preferences" },
    mutationFn: (patch: Partial<CastPreferences>) => apiRequest<CastPreferences>("/credits/preferences", { method: "PUT", body: JSON.stringify({ ...defaultCastPreferences, ...client.getQueryData<CastPreferences>(key), ...patch }) }),
    onSuccess: async value => { await client.cancelQueries({ queryKey: key }); client.setQueryData(key, value); },
  });
  const value = query.data ?? defaultCastPreferences;
  return { value, language: value.language === "system" ? systemCastLanguage() : value.language, save: (patch: Partial<CastPreferences>) => mutation.mutate(patch), busy: query.isPending || mutation.isPending, error: query.isError ? "Could not load cast preferences." : mutation.isError ? "Could not save cast preferences. Please try again." : undefined };
}
