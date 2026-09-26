import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useTrackingOverlays } from "./libraryDisplay";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("loads server preferences and shares successful saves across views", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ tracking_overlays: false }) }).mockResolvedValueOnce({ ok: true, json: async () => ({ tracking_overlays: true }) });
  vi.stubGlobal("fetch", fetcher);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const hook = renderHook(() => [useTrackingOverlays(), useTrackingOverlays()], { wrapper });
  await waitFor(() => expect(hook.result.current[0][0]).toBe(false));
  act(() => hook.result.current[0][1](true));
  await waitFor(() => expect(hook.result.current[1][0]).toBe(true));
  expect(fetcher).toHaveBeenLastCalledWith("/api/library-display", expect.objectContaining({ method: "PUT", body: '{"tracking_overlays":true}' }));
});
