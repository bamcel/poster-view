import {cleanup, render, screen, waitFor} from "@testing-library/react";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {MemoryRouter} from "react-router-dom";
import {afterEach, expect, it, vi} from "vitest";
import ActivityStatus from "./ActivityStatus";
import {nativeLibraries, type NativeLibrary} from "../api/nativeLibraries";
import {apiRequest} from "../api/client";
vi.mock("../api/nativeLibraries", () => ({nativeLibraries: {status: vi.fn()}}));
vi.mock("../api/client", () => ({apiRequest: vi.fn()}));
afterEach(() => {cleanup(); vi.resetAllMocks();});
const library = {id: "manga", name: "Manga"} as NativeLibrary;
function show() {
  const client = new QueryClient({defaultOptions: {queries: {retry: false}}});
  render(<QueryClientProvider client={client}><MemoryRouter><ActivityStatus libraries={[library]}/></MemoryRouter></QueryClientProvider>);
  return client;
}
it("shows automatic scan progress and updates when the scan completes", async () => {
  vi.mocked(apiRequest).mockResolvedValue([]);
  vi.mocked(nativeLibraries.status).mockResolvedValue({status: "scanning", count: 3, warnings: [], show_progress: false, manual_queued: true, progress: {phase: "reading", processed: 5, total: 10, current: "Manga/Book.cbz"}});
  const client = show();
  expect(await screen.findByText("Manga · Scanning")).toBeTruthy();
  expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("50");
  expect(screen.getByText("Manual scan queued")).toBeTruthy();
  vi.mocked(nativeLibraries.status).mockResolvedValue({status: "complete", count: 10, warnings: []});
  await client.invalidateQueries({queryKey: ["native-scan"]});
  expect(await screen.findByText("No active tasks")).toBeTruthy();
  expect(await screen.findByText("Manga · Scan completed")).toBeTruthy();
  expect(screen.queryByRole("progressbar")).toBeNull();
});
it("shows running maintenance and its latest result", async () => {
  vi.mocked(nativeLibraries.status).mockResolvedValue({status: "complete", count: 10, warnings: []});
  vi.mocked(apiRequest).mockResolvedValue([{id: "cleanup", title: "Data Cleanup", running: true, last_run: 100, last_result: "Removed 2 files."}]);
  const client = show();
  expect(await screen.findByText("Data Cleanup · Running")).toBeTruthy();
  vi.mocked(apiRequest).mockResolvedValue([{id: "cleanup", title: "Data Cleanup", running: false, last_run: 101, last_result: "Removed 3 files."}]);
  await client.invalidateQueries({queryKey: ["scheduled-tasks"]});
  expect(await screen.findByText("Data Cleanup · Completed")).toBeTruthy();
  expect(screen.getByText("Removed 3 files.")).toBeTruthy();
});
it("does not claim to be idle when status requests fail", async () => {
  vi.mocked(nativeLibraries.status).mockRejectedValue(new Error("Offline"));
  vi.mocked(apiRequest).mockRejectedValue(new Error("Offline"));
  show();
  await waitFor(() => expect(screen.getByText("Activity status unavailable")).toBeTruthy());
  expect(screen.queryByText("No active tasks")).toBeNull();
});
