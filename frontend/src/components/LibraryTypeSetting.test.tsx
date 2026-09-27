import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { apiRequest } from "../api/client";
import LibraryTypeSetting from "./LibraryTypeSetting";
vi.mock("../api/client", () => ({ apiRequest: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it("autosaves explicit anime classification and refreshes title data", async () => {
  vi.mocked(apiRequest).mockResolvedValue({ anime: true });
  const client = new QueryClient(); const invalidate = vi.spyOn(client, "invalidateQueries");
  render(<QueryClientProvider client={client}><LibraryTypeSetting serverId={3} library={{ id: "tv", title: "Anime shows", type: "show", anime: false }} /></QueryClientProvider>);
  fireEvent.change(screen.getByLabelText("Library type for Anime shows"), { target: { value: "anime" } });
  await waitFor(() => expect(apiRequest).toHaveBeenCalledWith("/servers/3/libraries/tv/anime", { method: "PUT", body: '{"anime":true}' }));
  await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["item-detail", 3] }));
  client.clear();
});
