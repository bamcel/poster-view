import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useTrackingOverlays } from "./libraryDisplay";

afterEach(() => { cleanup(); localStorage.clear(); });
it("defaults to visible and synchronizes saved preferences between views", () => {
  const first = renderHook(useTrackingOverlays);
  const second = renderHook(useTrackingOverlays);
  expect(first.result.current[0]).toBe(true);
  act(() => first.result.current[1](false));
  expect(second.result.current[0]).toBe(false);
  first.unmount();
  const reopened = renderHook(useTrackingOverlays);
  expect(reopened.result.current[0]).toBe(false);
  act(() => reopened.result.current[1](true));
  expect(second.result.current[0]).toBe(true);
});
