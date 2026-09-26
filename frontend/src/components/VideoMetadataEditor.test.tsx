import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { videoMetadataApi, type VideoDocument } from "../api/videoMetadata";
import VideoMetadataEditor from "./VideoMetadataEditor";

vi.mock("../api/videoMetadata", () => ({ videoMetadataApi: { get: vi.fn(), preview: vi.fn(), save: vi.fn() } }));
const doc: VideoDocument = { kind: "movie", target: "/media/Film/movie.nfo", choices: ["movie.nfo"], can_write: true, revision: "original XML", xml: "<movie><title>Original</title></movie>", fields: { title: "Original" }, actors: [{ name: "Actor", role: "Hero" }] };
beforeEach(() => { vi.mocked(videoMetadataApi.get).mockResolvedValue(structuredClone(doc)); });
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const mount = (onClose = vi.fn()) => render(<VideoMetadataEditor serverId={1} itemId="movie" onClose={onClose} />);
it("requires review before saving, preserves revision and shows NFO cast/XML", async () => {
  vi.mocked(videoMetadataApi.preview).mockResolvedValue({ ...doc, fields: { title: "Edited" }, xml: "<movie><title>Edited</title></movie>" });
  vi.mocked(videoMetadataApi.save).mockResolvedValue({ ...doc, fields: { title: "Edited" }, revision: "new XML" });
  mount(); await screen.findByDisplayValue("Original"); expect(screen.getByText("Actor — Hero")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Edited" } });
  fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
  await screen.findByRole("region", { name: "Review NFO changes" }); expect(videoMetadataApi.save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Save NFO" }));
  await waitFor(() => expect(videoMetadataApi.save).toHaveBeenCalledWith({ server_id: 1, item_id: "movie", target: doc.target, revision: doc.revision, fields: { title: "Edited" } }));
  await screen.findByText(/NFO saved/);
});
it("keeps edits after a conflict and invalidates a preview when a field changes", async () => {
  vi.mocked(videoMetadataApi.preview).mockResolvedValue({ ...doc, fields: { title: "Edited" } });
  vi.mocked(videoMetadataApi.save).mockRejectedValue(new Error("NFO changed. Reload before saving."));
  mount(); await screen.findByDisplayValue("Original");
  fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Edited" } });fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
  await screen.findByRole("button", { name: "Save NFO" });
  fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Edited again" } });expect(screen.queryByRole("button", { name: "Save NFO" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Review changes" }));fireEvent.click(await screen.findByRole("button", { name: "Save NFO" }));
  await screen.findByRole("alert");expect(screen.getByDisplayValue("Edited again")).toBeTruthy();
});
it("supports read-only review and does not write when no NFO exists", async () => {
  vi.mocked(videoMetadataApi.get).mockResolvedValue({ ...doc, can_write: false });mount();await screen.findByDisplayValue("Original");
  expect((screen.getByLabelText("Title") as HTMLInputElement).closest("fieldset")?.disabled).toBe(true);expect(screen.queryByRole("button", { name: "Review changes" })).toBeNull();
  cleanup();vi.mocked(videoMetadataApi.get).mockRejectedValue(new Error("No existing movie NFO found."));mount();await screen.findByRole("alert");expect(videoMetadataApi.save).not.toHaveBeenCalled();
});
it("asks before discarding unsaved edits on close", async () => {
  const close=vi.fn();mount(close);await screen.findByDisplayValue("Original");fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Edited" } });
  fireEvent.click(screen.getByRole("button", { name: "Close" }));expect(close).not.toHaveBeenCalled();fireEvent.click(screen.getByRole("button", { name: "Discard and close" }));expect(close).toHaveBeenCalledOnce();
});
