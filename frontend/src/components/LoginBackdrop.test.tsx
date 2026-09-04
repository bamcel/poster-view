import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import LoginBackdrop from "./LoginBackdrop";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("renders shuffled alternating poster rows from the sanitized feed", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ rows: [
    { posters: ["one", "two"] }, { posters: ["three", "four"] },
  ] }))));
  const { container } = render(<LoginBackdrop />);
  await waitFor(() => expect(container.querySelectorAll("img").length).toBeGreaterThanOrEqual(8));
  expect(container.querySelectorAll(".login-backdrop-row")).toHaveLength(2);
  expect(container.querySelectorAll(".login-backdrop-row-reverse")).toHaveLength(1);
  expect(container.querySelector(".login-backdrop-shade")).toBeTruthy();
  expect(screen.queryByRole("img")).toBeNull();
});

it("leaves the themed fallback cleanly when the cache is unavailable", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  const { container } = render(<LoginBackdrop />);
  await waitFor(() => expect(fetch).toHaveBeenCalled());
  expect(container.innerHTML).toBe("");
});
