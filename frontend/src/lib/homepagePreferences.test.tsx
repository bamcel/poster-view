import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { AuthSession } from "../api/client";
import { AuthSessionContext } from "./authContext";
import { useHomepageNavigation } from "./homepagePreferences";

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("remembers navigation independently for each account",()=>{
 let id="navigation-alice";
 const wrapper=({children}:{children:ReactNode})=><AuthSessionContext.Provider value={{user:{id}} as AuthSession}>{children}</AuthSessionContext.Provider>;
 const view=renderHook(useHomepageNavigation,{wrapper});
 expect(view.result.current[0]).toBe(false);
 act(()=>view.result.current[1](true));
 id="navigation-bob";view.rerender();expect(view.result.current[0]).toBe(false);
 id="navigation-alice";view.rerender();expect(view.result.current[0]).toBe(true);
});
