import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import NativeLibrariesSection, { LibraryDialog } from "./NativeLibrariesSection";
import { defaultNativeOptions, nativeLibraries, type NativeLibrary } from "../api/nativeLibraries";

vi.mock("../api/nativeLibraries", async importOriginal => ({...(await importOriginal<typeof import("../api/nativeLibraries")>()), nativeLibraries: { list: vi.fn(), save: vi.fn(), folders: vi.fn(), status: vi.fn(), catalog: vi.fn(), previews: vi.fn(), scan: vi.fn(), remove: vi.fn() } }));
const saved: NativeLibrary = { id: "library", name: "Anime", library_type: "anime", anime_content: "both", paths: ["Shows", "Movies"], revision: 1, created_at: "", updated_at: "" };
function mount(component: React.ReactNode) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{component}</QueryClientProvider>);
}
beforeEach(() => {
  vi.mocked(nativeLibraries.list).mockResolvedValue([]);
  vi.mocked(nativeLibraries.previews).mockResolvedValue([]);
  vi.mocked(nativeLibraries.save).mockResolvedValue(saved);
  vi.mocked(nativeLibraries.folders).mockImplementation(async path => ({ root: "/media", path, folders: path ? [{ name: "Season 1", path: `${path}/Season 1`, has_nfo: false }] : [{ name: "Shows", path: "Shows", has_nfo: false }, { name: "Movies", path: "Movies", has_nfo: false }] }));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("creates an Anime library with multiple media folders and no remote-server import", async () => {
  mount(<NativeLibrariesSection />);
  fireEvent.click(screen.getByRole("button", { name: "Add library" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Anime" } });
  fireEvent.change(screen.getByLabelText("Library type"), { target: { value: "anime" } });
  expect((screen.getByLabelText("Anime content") as HTMLSelectElement).value).toBe("both");
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  fireEvent.click(await screen.findByRole("checkbox", { name: "Shows" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Movies" }));
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  fireEvent.click(screen.getByRole("button", { name: /Review/ }));
  fireEvent.click(screen.getByRole("button", { name: "Create library" }));
  await waitFor(() => expect(nativeLibraries.save).toHaveBeenCalledWith({ name: "Anime", library_type: "anime", anime_content: "both", paths: ["Shows", "Movies"], options: defaultNativeOptions, revision: null }, undefined));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("keeps selected folders across navigation and prevents overlapping roots", async () => {
  mount(<LibraryDialog onClose={vi.fn()} onSaved={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "TV" } });
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  fireEvent.click(await screen.findByRole("checkbox", { name: "Shows" }));
  fireEvent.click(screen.getByRole("button", { name: "Open Shows" }));
  fireEvent.click(await screen.findByRole("checkbox", { name: "Season 1" }));
  expect(screen.getByText(/Selected folders overlap/)).toBeTruthy();
  expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Remove /media/Shows" }));
  expect(screen.getByText("/media/Shows/Season 1")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(false);
});

it("protects dirty drafts on Escape and restores body scrolling", () => {
  const close = vi.fn();
  const view = mount(<LibraryDialog onClose={close} onSaved={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Books" } });
  fireEvent.keyDown(document, { key: "Escape" });
  expect(close).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
  expect(close).toHaveBeenCalledOnce();
  view.unmount(); expect(document.body.style.overflow).toBe("");
});

it("submits the existing revision when editing and keeps errors visible", async () => {
  vi.mocked(nativeLibraries.save).mockRejectedValue(new Error("Library changed since it was opened."));
  mount(<LibraryDialog library={saved} onClose={vi.fn()} onSaved={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: /Review/ }));
  fireEvent.click(screen.getByRole("button", { name: "Save library" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Library changed since it was opened.");
  expect(nativeLibraries.save).toHaveBeenCalledWith(expect.objectContaining({ revision: 1 }), "library");
});

it("groups library actions in the menu and confirms removal", async () => {
  vi.mocked(nativeLibraries.list).mockResolvedValue([saved]);
  vi.mocked(nativeLibraries.status).mockResolvedValue({status: "complete", count: 4, warnings: []});
  vi.mocked(nativeLibraries.scan).mockResolvedValue(undefined);
  vi.mocked(nativeLibraries.remove).mockResolvedValue(undefined);
  mount(<NativeLibrariesSection />);
  fireEvent.click(await screen.findByLabelText("Actions for Anime"));
  fireEvent.click(await screen.findByRole("button", {name: "Scan Library Files"}));
  await waitFor(() => expect(nativeLibraries.scan).toHaveBeenCalledWith(saved.id));
  expect(screen.queryByRole("dialog")).toBeNull();
  await waitFor(() => expect((screen.getByRole("button", {name: "Remove"}) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", {name: "Remove"}));
  expect(nativeLibraries.remove).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", {name: "Confirm removal"}));
  await waitFor(() => expect(nativeLibraries.remove).toHaveBeenCalledWith(saved.id, saved.revision));
  expect(screen.queryByRole("dialog")).toBeNull();
});
