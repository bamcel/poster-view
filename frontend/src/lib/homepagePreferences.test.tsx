import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { AuthSession } from "../api/client";
import { AuthSessionContext } from "./authContext";
import { useHomepageHeadline,useHomepageNavigation } from "./homepagePreferences";

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("defaults to backdrop and persists browser-local changes across consumers and remounts", () => {
  const first = renderHook(useHomepageHeadline);
  const second = renderHook(useHomepageHeadline);
  expect(first.result.current[0]).toBe("backdrop");
  act(() => first.result.current[1]("banner"));
  expect(second.result.current[0]).toBe("banner");
  first.unmount();
  expect(renderHook(useHomepageHeadline).result.current[0]).toBe("banner");
});

it("isolates users and synchronously reads the new account's preference", () => {
  let id = "alice";
  const wrapper = ({ children }: { children: ReactNode }) => <AuthSessionContext.Provider value={{ user: { id } } as AuthSession}>{children}</AuthSessionContext.Provider>;
  const view = renderHook(useHomepageHeadline, { wrapper });
  act(() => view.result.current[1]("banner"));
  id = "bob";
  view.rerender();
  expect(view.result.current[0]).toBe("backdrop");
  id = "alice";
  view.rerender();
  expect(view.result.current[0]).toBe("banner");
});

it("refreshes from storage and account events and rejects invalid stored values", () => {
  const view = renderHook(useHomepageHeadline);
  act(() => {
    localStorage.setItem("posterview:homepage-headline:local", "banner");
    window.dispatchEvent(new StorageEvent("storage", { key: "posterview:homepage-headline:local" }));
  });
  expect(view.result.current[0]).toBe("banner");
  act(() => {
    localStorage.setItem("posterview:homepage-headline:local", "invalid");
    window.dispatchEvent(new Event("posterview:account-changed"));
  });
  expect(view.result.current[0]).toBe("backdrop");
});

it("remains usable when browser storage is blocked", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
  const view = renderHook(useHomepageHeadline);
  expect(view.result.current[0]).toBe("backdrop");
  expect(() => act(() => view.result.current[1]("banner"))).not.toThrow();
  expect(view.result.current[0]).toBe("backdrop");
});

it("remembers navigation independently for each account",()=>{
 let id="navigation-alice";
 const wrapper=({children}:{children:ReactNode})=><AuthSessionContext.Provider value={{user:{id}} as AuthSession}>{children}</AuthSessionContext.Provider>;
 const view=renderHook(useHomepageNavigation,{wrapper});
 expect(view.result.current[0]).toBe(false);
 act(()=>view.result.current[1](true));
 id="navigation-bob";view.rerender();expect(view.result.current[0]).toBe(false);
 id="navigation-alice";view.rerender();expect(view.result.current[0]).toBe(true);
});
