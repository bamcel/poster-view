import { useEffect, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { applyDashboardAppearance, dashboardAppearance } from "../lib/dashboardSettings";
import { applyThemePreferences, exportThemePreferences } from "../lib/theme";

export default function AppearanceBootstrap({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const settingsQ = useQuery({ queryKey: ["appearance-settings"], queryFn: api.appearanceSettings });

  useEffect(() => {
    const settings = settingsQ.data;
    if (!settings) return;
    if (!settings.configured) {
      const local = { ...dashboardAppearance(), ...exportThemePreferences(), configured: true };
      void api.saveAppearanceSettings(local).then((saved) => {
        queryClient.setQueryData(["appearance-settings"], saved);
      });
      return;
    }
    applyDashboardAppearance(settings);
    applyThemePreferences(settings.theme_name, settings.custom_themes_json);
  }, [queryClient, settingsQ.data]);

  return children;
}
