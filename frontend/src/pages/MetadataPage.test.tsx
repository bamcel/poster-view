import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import MetadataPage from "./MetadataPage";
import { metadataApi, type MetadataDocument } from "../api/metadata";

vi.mock("../api/metadata", () => ({ metadataApi: { folders: vi.fn(), read: vi.fn(), preview: vi.fn(), save: vi.fn(), search: vi.fn() } }));
const document: MetadataDocument = { path: "Manga", target: "/data/media/Manga/Manga.nfo", revision: null, xml: "<series><title>Manga</title></series>", fields: { title: "Manga", year: "", publisher: "", edition: "Color", volumes: "", status: "", plot: "", anilist_id: "" } };
beforeEach(() => {
  vi.mocked(metadataApi.folders).mockResolvedValue({ root: "/data/media", path: "", folders: [{ name: "Manga", path: "Manga", has_nfo: false }, { name: "Existing", path: "Existing", has_nfo: true }] });
  vi.mocked(metadataApi.read).mockResolvedValue(document);
  vi.mocked(metadataApi.preview).mockImplementation(async request => ({ ...document, ...request }));
  vi.mocked(metadataApi.save).mockImplementation(async request => ({ ...document, ...request, revision: "saved" }));
});
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.restoreAllMocks(); });
function mount() { return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><MetadataPage /></QueryClientProvider>); }

it("does not write on browse, requires preview, and invalidates preview after an edit", async () => {
  mount();
  fireEvent.click((await screen.findByText("Manga")).closest("button")!);
  await screen.findByLabelText("Publisher");
  expect(metadataApi.save).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Save beside series" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Preview NFO" }));
  await screen.findByRole("button", { name: "Save beside series" });
  fireEvent.change(screen.getByLabelText("Publisher"), { target: { value: "Edition Publisher" } });
  expect(screen.queryByRole("button", { name: "Save beside series" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Preview NFO" }));
  fireEvent.click(await screen.findByRole("button", { name: "Save beside series" }));
  await screen.findByText(/Saved beside the series/);
  expect(metadataApi.save).toHaveBeenCalledWith(expect.objectContaining({ path: "Manga", fields: expect.objectContaining({ publisher: "Edition Publisher" }), revision: null }));
});

it("keeps edition-specific data when importing an AniList match", async () => {
  vi.mocked(metadataApi.search).mockResolvedValue([{ ...document.fields, title: "Matched Manga", plot: "One &amp; two<br>Next <i>line</i>", edition: "", year: "2020", status: "Completed", anilist_id: "123" }]);
  mount();
  fireEvent.click((await screen.findByText("Manga")).closest("button")!);
  fireEvent.change(await screen.findByLabelText("Publisher"), { target: { value: "Local Publisher" } });
  fireEvent.change(screen.getByLabelText("Edition volumes (confirmed total)"), { target: { value: "6" } });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  fireEvent.click(await screen.findByRole("button", { name: /Matched Manga/ }));
  expect((screen.getByLabelText("Publisher") as HTMLInputElement).value).toBe("Local Publisher");
  expect((screen.getByLabelText("Edition") as HTMLInputElement).value).toBe("Color");
  expect((screen.getByLabelText("Edition volumes (confirmed total)") as HTMLInputElement).value).toBe("6");
  expect((screen.getByLabelText("Synopsis") as HTMLTextAreaElement).value).toBe("One & two\nNext line");
  expect(metadataApi.save).not.toHaveBeenCalled();
});

it("bulk creation skips files that appeared after listing", async () => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
  vi.mocked(metadataApi.read).mockResolvedValue({ ...document, revision: "created elsewhere" });
  mount();
  fireEvent.click(await screen.findByLabelText("Select visible folders missing NFO"));
  fireEvent.click(screen.getByRole("button", { name: "Create 1 missing NFOs" }));
  await waitFor(() => expect(metadataApi.read).toHaveBeenCalled());
  await waitFor(() => expect(screen.getByText(/skipped — already exists/)).toBeTruthy());
  expect(metadataApi.save).not.toHaveBeenCalled();
});
