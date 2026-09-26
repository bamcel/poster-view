import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import ScheduledTasks from "./ScheduledTasks";
import { tasksApi, type ScheduledTask } from "../api/tasks";
vi.mock("../api/tasks", () => ({ tasksApi: { list: vi.fn(), save: vi.fn().mockResolvedValue({}), action: vi.fn() } }));
const task: ScheduledTask = { id: "missing_credits", config: { name: "Fetch Missing Cast & Crew", kind: "missing_credits", providers: ["anilist"], enabled: false, interval_hours: 24, stale_days: 30 }, status: "idle", next_run: null, started_at: null, finished_at: null, processed: 0, total: 0, updated: 0, skipped: 0, failed: 0, needs_matching: 0, current_title: null, message: "Ready", issues: [], history: [] };
function mount(value = task) {
  vi.mocked(tasksApi.list).mockResolvedValue([value]);
  vi.mocked(tasksApi.action).mockResolvedValue([value]);
  render(<MemoryRouter><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ScheduledTasks /></QueryClientProvider></MemoryRouter>);
}
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it("shows built-in list rows and runs without library selection or creation", async () => {
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Run Fetch Missing Cast & Crew" }));
  await waitFor(() => expect(tasksApi.action).toHaveBeenCalledWith("missing_credits", "run"));
  expect(screen.queryByText("New Task")).toBeNull();
  expect(screen.queryByLabelText("Media server")).toBeNull();
  expect(screen.queryByText("Delete")).toBeNull();
  expect(screen.getByText("Fetch Missing Cast & Crew").closest("li")).not.toBeNull();
});
it("saves schedule changes without changing the fixed task scope", async () => {
  mount();
  fireEvent.click(await screen.findByLabelText("Enable recurring schedule"));
  fireEvent.change(screen.getByLabelText("Repeat every (hours)"), { target: { value: "12" } });
  fireEvent.click(screen.getByText("Save Schedule"));
  await waitFor(() => expect(tasksApi.save).toHaveBeenCalledWith(expect.objectContaining({ enabled: true, interval_hours: 12 }), "missing_credits"));
});
it("offers cancellation for running tasks and links issues to their originating server", async () => {
  mount({ ...task, status: "running", issues: [{ server_id: 7, item_id: "same-id", title: "Series", message: "Match needed", needs_matching: true }] });
  fireEvent.click(await screen.findByRole("button", { name: "Cancel Fetch Missing Cast & Crew" }));
  await waitFor(() => expect(tasksApi.action).toHaveBeenCalledWith("missing_credits", "cancel"));
  expect(screen.getByText("Series").getAttribute("href")).toBe("/server/7/item/same-id");
});
