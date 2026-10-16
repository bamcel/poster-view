import {act, cleanup, renderHook} from "@testing-library/react";
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import {useFeaturedRotation} from "./useFeaturedRotation";

let reduced = false;
let motionChanged: () => void;
const removeMotion = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  reduced = false;
  removeMotion.mockClear();
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  vi.stubGlobal("matchMedia", () => ({get matches() {return reduced;}, addEventListener: (_: string, listener: () => void) => {motionChanged = listener;}, removeEventListener: removeMotion}));
});
afterEach(() => {cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();});
const advance = (milliseconds = 12_000) => act(() => vi.advanceTimersByTime(milliseconds));

it("rotates every twelve seconds without restarting on fresh equivalent arrays", () => {
  const view = renderHook(({keys}) => useFeaturedRotation(keys), {initialProps: {keys: ["a", "b", "c"]}});
  advance(6_000);
  view.rerender({keys: ["a", "b", "c"]});
  advance(6_000);
  expect(view.result.current.index).toBe(1);
  advance();
  expect(view.result.current.index).toBe(2);
  advance();
  expect(view.result.current.index).toBe(0);
});

it("pauses during interaction and explicit pause, while manual navigation still wraps", () => {
  const {result} = renderHook(() => useFeaturedRotation(["a", "b"]));
  act(() => result.current.setInteracting(true));
  advance(24_000);
  expect(result.current.index).toBe(0);
  act(() => {result.current.setInteracting(false); result.current.setPaused(true);});
  advance();
  expect(result.current.paused).toBe(true);
  act(() => result.current.previous());
  expect(result.current.index).toBe(1);
  act(() => result.current.next());
  expect(result.current.index).toBe(0);
  act(() => result.current.setPaused(false));
  advance();
  expect(result.current.index).toBe(1);
});

it("retains the title when reordered and immediately falls back when removed", () => {
  const view = renderHook(({keys}) => useFeaturedRotation(keys), {initialProps: {keys: ["a", "b", "c"]}});
  act(() => view.result.current.next());
  view.rerender({keys: ["b", "a"]});
  expect(view.result.current.index).toBe(0);
  view.rerender({keys: ["c"]});
  expect(view.result.current.index).toBe(0);
  advance();
  expect(view.result.current.index).toBe(0);
  view.rerender({keys: []});
  act(() => view.result.current.previous());
  expect(view.result.current.index).toBe(0);
});

it("honors initial reduced motion and changes, and resumes only when visible", () => {
  reduced = true;
  const {result} = renderHook(() => useFeaturedRotation(["a", "b"]));
  expect(result.current.paused).toBe(true);
  advance();
  expect(result.current.index).toBe(0);
  act(() => {reduced = false; motionChanged();});
  vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  advance();
  expect(result.current.index).toBe(0);
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  advance();
  expect(result.current.index).toBe(1);
  act(() => {reduced = true; motionChanged();});
  advance();
  expect(result.current.index).toBe(1);
});

it("cleans up pending rotation and listeners on unmount", () => {
  const view = renderHook(() => useFeaturedRotation(["a", "b"]));
  expect(vi.getTimerCount()).toBe(1);
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
  expect(removeMotion).toHaveBeenCalledWith("change", expect.any(Function));
});
