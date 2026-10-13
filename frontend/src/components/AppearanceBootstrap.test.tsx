import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import AppearanceBootstrap from "./AppearanceBootstrap";
import { AuthSessionContext } from "../lib/authContext";
import { api } from "../api/client";

vi.mock("../api/client", () => ({
  api: { appearanceSettings: vi.fn(), saveAppearanceSettings: vi.fn() },
}));
afterEach(cleanup);

it("does not save server appearance while starting a regular user session", async () => {
  vi.mocked(api.appearanceSettings).mockResolvedValue({ configured: false } as never);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const session = {
    authenticated: true,
    user: {
      id: "viewer", username: "viewer", display_name: "Viewer", role: "user" as const,
      enabled: true, revision: 1, created_at: "",
      permissions: {
        all_libraries: true, library_ids: [], max_movie_rating: null,
        max_tv_rating: null, allow_unrated: false,
      },
    },
  };
  render(
    <QueryClientProvider client={client}>
      <AuthSessionContext.Provider value={session}>
        <AppearanceBootstrap><p>Viewer home</p></AppearanceBootstrap>
      </AuthSessionContext.Provider>
    </QueryClientProvider>,
  );
  expect(screen.getByText("Viewer home")).toBeTruthy();
  await waitFor(() => expect(client.getQueryData(["appearance-settings"])).toEqual({ configured: false }));
  expect(api.saveAppearanceSettings).not.toHaveBeenCalled();
});
