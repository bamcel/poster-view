import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import ScheduledTasks from "./ScheduledTasks";
import { tasksApi } from "../api/tasks";
vi.mock("../api/client", () => ({ api: { listServers: vi.fn().mockResolvedValue([{ id: 1, name: "Home" }]), getLibraries: vi.fn().mockResolvedValue([{ id: "tv", title: "Anime", type: "show" }, { id: "movies", title: "Movies", type: "movie" }]) } }));
vi.mock("../api/tasks", () => ({ tasksApi: { list: vi.fn().mockResolvedValue([]), save: vi.fn().mockResolvedValue({}), action: vi.fn() } }));
afterEach(cleanup);
it("creates a scoped manual task and requires library selection", async () => {
  render(<MemoryRouter><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ScheduledTasks /></QueryClientProvider></MemoryRouter>);
  await waitFor(() => expect((screen.getByText("New Task") as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByText("New Task"));
  expect((screen.getByText("Save Task") as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(await screen.findByLabelText("Anime"));
  expect(screen.queryByLabelText("Movies")).toBeNull();
  fireEvent.click(screen.getByText("Save Task"));
  await waitFor(() => expect(tasksApi.save).toHaveBeenCalledWith(expect.objectContaining({ library_ids: ["tv"], enabled: false, providers: ["anilist"], kind: "missing_credits" }), undefined));
});

