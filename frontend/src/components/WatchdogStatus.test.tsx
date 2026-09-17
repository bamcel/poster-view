import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import WatchdogStatus from "./WatchdogStatus";
import type { ArtworkCacheStatus } from "../types";

afterEach(cleanup);
const status: ArtworkCacheStatus = {
  server_id: 1, server_name: "Family", max_mb: 250, ttl_days: 30, used_bytes: 0, file_count: 0,
  watchdog_enabled: false, watchdog_interval_hours: 24, watchdog_running: false, watchdog_state: "idle",
  watchdog_progress_current: 2, watchdog_progress_total: 10, watchdog_cancel_requested: false,
  watchdog_last_run: "2026-09-17T12:00:00Z", watchdog_last_message: "Watchdog cancelled.",
};

it("shows the actual phase and avoids showing stale preload progress during scanning", () => {
  const view = render(<WatchdogStatus status={status} />);
  expect(screen.getByText("Watchdog: Idle")).toBeTruthy();
  expect(screen.getByText("No successful run yet")).toBeTruthy();
  expect(screen.getByText("Automatic preloading is off")).toBeTruthy();
  view.rerender(<WatchdogStatus status={{ ...status, watchdog_running: true, watchdog_state: "scanning" }} />);
  expect(screen.getByText("Watchdog: Scanning")).toBeTruthy();
  expect(screen.queryByRole("progressbar")).toBeNull();
  view.rerender(<WatchdogStatus status={{ ...status, watchdog_running: true, watchdog_state: "preloading", watchdog_current_title: "Movie" }} />);
  expect(screen.getByText("Watchdog: Preloading")).toBeTruthy();
  expect(screen.getByRole("progressbar", { name: "Titles preloaded" }).getAttribute("value")).toBe("2");
  view.rerender(<WatchdogStatus status={{ ...status, watchdog_running: true, watchdog_cancel_requested: true }} />);
  expect(screen.getByText("Watchdog: Stopping")).toBeTruthy();
  view.rerender(<WatchdogStatus status={{ ...status, watchdog_state: "failed", watchdog_last_message: "Invalid credentials" }} />);
  expect(screen.getByText("Watchdog: Failed")).toBeTruthy();
  expect(screen.getByText("Invalid credentials")).toBeTruthy();
});

it("keeps the last successful run separate from attempts and shows the next retry", () => {
  render(<WatchdogStatus status={{ ...status, watchdog_state: "failed", watchdog_last_successful_run: "2026-09-16T12:00:00Z", watchdog_next_run: "2026-09-17T12:05:00Z" }} />);
  expect([...document.querySelectorAll("time")].map(time => time.dateTime)).toEqual(["2026-09-16T12:00:00Z", "2026-09-17T12:05:00Z"]);
});
