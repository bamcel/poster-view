import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "./App";
import { api } from "./api/client";

vi.mock("./api/client", () => ({
  api: { authStatus: vi.fn(), authLogin: vi.fn(), listServers: vi.fn(), appearanceSettings: vi.fn(), saveAppearanceSettings: vi.fn() },
}));
vi.mock("./components/Layout", async () => {
  const { useServers } = await import("./lib/serverContext");
  return { default: () => {
    const { selectedServer } = useServers();
    return <div>{selectedServer?.name ?? "No selected server"}</div>;
  } };
});
vi.mock("./pages/DashboardPage", () => ({ default: () => null }));
vi.mock("./pages/ItemDetailPage", () => ({ default: () => null }));
vi.mock("./pages/SettingsPage", () => ({ default: () => null }));
vi.mock("./pages/HistoryPage", () => ({ default: () => null }));

afterEach(cleanup);
beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  vi.mocked(api.appearanceSettings).mockResolvedValue({ configured: true, backdrops_enabled: false, panel_solidity: 40, panel_blur: 12, panel_overlay: 0, backdrop_overlay: 72, theme_name: "Everforest", custom_themes_json: "[]" });
});

it("loads the saved server only after signing in following a restart", async () => {
  vi.mocked(api.authStatus).mockResolvedValue({ authenticated: false });
  vi.mocked(api.authLogin).mockResolvedValue({ authenticated: true });
  vi.mocked(api.listServers).mockResolvedValue([
    { id: 1, name: "Emby Tailscale", type: "emby", base_url: "http://media:8096",
      is_default: true, nfo_metadata_enabled: false, has_token: true, created_at: "2026-09-03", updated_at: "2026-09-03" },
  ]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter><App /></MemoryRouter>
    </QueryClientProvider>,
  );

  const password = await screen.findByLabelText("Password");
  expect(api.listServers).not.toHaveBeenCalled();
  fireEvent.change(password, { target: { value: "correct-password" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

  expect(await screen.findByText("Emby Tailscale")).toBeTruthy();
  expect(api.listServers).toHaveBeenCalledTimes(1);
  client.clear();
});
