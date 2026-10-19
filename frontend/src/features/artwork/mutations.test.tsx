import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useArtworkMutationFeedback } from "./mutations";

const push = vi.fn();
vi.mock("../../lib/toast", () => ({useToast: () => ({push})}));
afterEach(() => {cleanup(); push.mockReset();});
function setup(serverId = 7, itemId = "show") {
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const hook = renderHook(() => useArtworkMutationFeedback(serverId, itemId), {wrapper: ({children}) => <QueryClientProvider client={client}>{children}</QueryClientProvider>});
  return {feedback: hook.result.current, invalidate, client};
}
it("refreshes parent detail and server catalog after applying a season image", async () => {
  const {feedback, invalidate} = setup();
  await act(() => feedback.complete({ok: true, message: "Applied"}, "season", "poster"));
  expect(push).toHaveBeenCalledWith("success", "Applied");
  expect(invalidate).toHaveBeenCalledWith({queryKey: ["items", 7]});
  expect(invalidate).toHaveBeenCalledWith({queryKey: ["item-detail", 7, "show"]});
});
it("surfaces failed responses and exceptions without refreshing saved artwork", async () => {
  const {feedback, invalidate} = setup();
  await act(() => feedback.complete({ok: false, message: "Not saved"}));
  feedback.fail(new Error("Request failed"));
  expect(push).toHaveBeenCalledWith("error", "Not saved");
  expect(push).toHaveBeenCalledWith("error", "Request failed");
  expect(invalidate).not.toHaveBeenCalled();
});
it("defaults refresh to current collection without a success notification", async () => {
  const {feedback, invalidate} = setup(0, "collection:one");
  await act(() => feedback.refresh());
  expect(invalidate).toHaveBeenCalledWith({queryKey: ["collections"]});
  expect(invalidate).toHaveBeenCalledWith({queryKey: ["item-detail", 0, "collection:one"]});
  expect(push).not.toHaveBeenCalled();
});
it("preserves native optimistic image revision updates", async () => {
  const {feedback, client, invalidate} = setup(0, "native:lib:show");
  client.setQueryData(["native-catalog", "lib"], [{id: "show", kind: "show", artwork: [], revision: 2}]);
  await act(() => feedback.complete({ok: true, message: "Saved"}, undefined, "background"));
  expect(client.getQueryData(["native-catalog", "lib"])).toEqual([{id: "show", kind: "show", artwork: [{kind: "backdrop", path: "", source: "manual"}], revision: 3}]);
  expect(invalidate).toHaveBeenCalledWith({queryKey: ["native-catalog", "lib"]});
});
