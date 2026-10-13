import { afterEach, expect, it, vi } from "vitest";
import { trackWatchReport, waitForWatchReports } from "./watchReports";

const item = "library\u0000item";
afterEach(() => { window.dispatchEvent(new Event("posterview:account-changed")); vi.useRealTimers(); });

it("waits for the predecessor's final progress before allowing a replacement watch", async () => {
  let finish!: () => void;
  trackWatchReport(item, new Promise<void>(resolve => { finish = resolve; }));
  const continued = vi.fn();
  const opening = waitForWatchReports(item).then(continued);
  await Promise.resolve();
  expect(continued).not.toHaveBeenCalled();
  finish();
  await opening;
  expect(continued).toHaveBeenCalledTimes(1);
});

it("gives a recoverable error instead of replacing a token while final progress is delayed", async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  trackWatchReport(item, new Promise<void>(resolve => { finish = resolve; }));
  const opening = expect(waitForWatchReports(item)).rejects.toThrow("still saving");
  await vi.advanceTimersByTimeAsync(3000);
  await opening;
  finish();
  await waitForWatchReports(item);
});

it("does not delay or coordinate the next account against the previous account's saves", async () => {
  let finish!: () => void;
  trackWatchReport(item, new Promise<void>(resolve => { finish = resolve; }));
  const oldOpening = expect(waitForWatchReports(item)).rejects.toMatchObject({ name: "AbortError" });
  window.dispatchEvent(new Event("posterview:account-changed"));
  await oldOpening;
  await waitForWatchReports(item);
  finish();
});
