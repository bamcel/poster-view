import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import ImdbSource, { ImdbMetadata } from "./ImdbSource";
import { imdbApi } from "../api/imdb";
import { tasksApi } from "../api/tasks";
vi.mock("../api/imdb", () => ({ imdbApi: { status: vi.fn(), enable: vi.fn(), search: vi.fn() } }));
vi.mock("../api/tasks", () => ({ tasksApi: { action: vi.fn().mockResolvedValue([]) } }));
const status = { enabled: false, ready: false, updated_at: null, titles: 0, ratings: 0 };
function mount(children: React.ReactNode) { render(<MemoryRouter><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider></MemoryRouter>); }
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it("requires opt-in and queues the built-in download rather than downloading on enable", async () => {
  vi.mocked(imdbApi.status).mockResolvedValue(status);
  vi.mocked(imdbApi.enable).mockResolvedValue({ ...status, enabled: true });
  mount(<ImdbSource />);
  await waitFor(() => expect((screen.getByRole("switch") as HTMLButtonElement).disabled).toBe(false));
  expect(screen.queryByText("Download IMDb Data")).toBeNull();
  fireEvent.click(screen.getByRole("switch"));
  const download = await screen.findByText("Download IMDb Data");
  expect(tasksApi.action).not.toHaveBeenCalled();
  fireEvent.click(download);
  await waitFor(() => expect(tasksApi.action).toHaveBeenCalledWith("imdb_refresh", "run"));
});
it("looks up the linked ID and labels its source and rating", async () => {
  vi.mocked(imdbApi.status).mockResolvedValue({ ...status, enabled: true, ready: true });
  vi.mocked(imdbApi.search).mockResolvedValue([{ id: "tt0000001", title_type: "movie", title: "Example", original_title: "Example", year: 2020, end_year: null, runtime_minutes: 100, genres: ["Drama"], rating: 8.2, votes: 1234 }]);
  mount(<ImdbMetadata id="tt0000001" />);
  expect(await screen.findByText(/IMDb 8.2/)).toBeTruthy();
  expect(imdbApi.search).toHaveBeenCalledWith("tt0000001");
  expect(screen.getByText(/Used with permission/)).toBeTruthy();
});
