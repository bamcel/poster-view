import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import LoginBackdrop from "./LoginBackdrop";

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("renders shuffled alternating poster rows from the sanitized feed", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ rows: [
    { posters: ["one", "two"] }, { posters: ["three", "four"] },
  ] }))));
  const { container } = render(<LoginBackdrop />);
  await waitFor(() => expect(container.querySelectorAll("img").length).toBeGreaterThanOrEqual(8));
  expect(container.querySelectorAll(".login-backdrop-row")).toHaveLength(2);
  expect(container.querySelectorAll(".login-backdrop-row-reverse")).toHaveLength(1);
  const durations = Array.from(container.querySelectorAll<HTMLElement>(".login-backdrop-row"))
    .map((row) => row.style.getPropertyValue("--backdrop-duration"));
  expect(new Set(durations)).toEqual(new Set(["109.375s"]));
  expect(container.querySelector(".login-backdrop-shade")).toBeTruthy();
  expect(screen.queryByRole("img")).toBeNull();
});

it("leaves the themed fallback cleanly when the cache is unavailable", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  const { container } = render(<LoginBackdrop />);
  await waitFor(() => expect(fetch).toHaveBeenCalled());
  expect(container.innerHTML).toBe("");
});

it("retries an empty startup cache and renders posters when generation finishes", async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ rows: [] })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ rows: [{ posters: ["one", "two"] }] })));
  vi.stubGlobal("fetch", fetchMock);
  const { container } = render(<LoginBackdrop />);
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(container.querySelectorAll("img")).toHaveLength(0);
  await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
  expect(container.querySelectorAll("img").length).toBeGreaterThan(0);
});
