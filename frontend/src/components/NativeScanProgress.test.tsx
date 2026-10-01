import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import NativeScanProgress from "./NativeScanProgress";
afterEach(cleanup);
it("shows discovery without inventing a percentage, then live reading counts", () => {
  const view = render(<NativeScanProgress status={{status: "scanning", count: 0, warnings: [], progress: {phase: "discovering", processed: 20, total: null, current: "Anime/Example.mkv"}}} />);
  expect(screen.getByText("20 files found")).toBeTruthy();
  expect(screen.getByRole("progressbar").hasAttribute("aria-valuenow")).toBe(false);
  view.rerender(<NativeScanProgress status={{status: "scanning", count: 12, warnings: [], progress: {phase: "reading", processed: 5, total: 20, current: "Anime/Example.mkv"}}} />);
  expect(screen.getByRole("status").textContent).toContain("12 items");
  expect(screen.getByText("5 / 20 files processed · 25%")).toBeTruthy();
  expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("25");
  expect(screen.getByText("/media/Anime/Example.mkv")).toBeTruthy();
  view.rerender(<NativeScanProgress status={{status: "complete", count: 30, warnings: []}} />);
  expect(screen.getByRole("status").textContent).toContain("30 items");
  expect(screen.queryByRole("progressbar")).toBeNull();
});
