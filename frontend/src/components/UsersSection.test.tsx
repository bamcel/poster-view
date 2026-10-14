import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import UsersSection from "./UsersSection";
import { api, type UserAccount } from "../api/client";

vi.mock("../api/client", () => ({
  api: { users: vi.fn(), createUser: vi.fn(), updateUser: vi.fn(), deleteUser: vi.fn() },
}));
vi.mock("../api/nativeLibraries", () => ({
  nativeLibraries: { list: vi.fn(async () => [{ id: "movies", name: "Family movies" }]) },
}));

const account: UserAccount = {
  id: "u", username: "viewer", display_name: "Viewer", role: "user",
  enabled: true, revision: 4, created_at: "",
  permissions: {
    all_libraries: true, library_ids: [], max_movie_rating: null,
    max_tv_rating: null, allow_unrated: false,
  },
};

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><UsersSection /></QueryClientProvider>);
}

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.users).mockResolvedValue([account]);
  vi.mocked(api.createUser).mockResolvedValue(account);
  vi.mocked(api.updateUser).mockResolvedValue(account);
});

it("creates a viewer with explicit libraries and separate content ceilings", async () => {
  mount();
  fireEvent.click(screen.getByRole("button", { name: "Create user" }));
  fireEvent.change(screen.getByLabelText("Username"), { target: { value: "child" } });
  fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Child" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret1234" } });
  fireEvent.click(screen.getByLabelText("Allow all libraries, including future libraries"));
  fireEvent.click(await screen.findByLabelText("Family movies"));
  fireEvent.change(screen.getByLabelText("Maximum movie rating"), { target: { value: "PG-13" } });
  fireEvent.change(screen.getByLabelText("Maximum TV rating"), { target: { value: "TV-PG" } });
  fireEvent.click(screen.getByRole("button", { name: "Save user" }));
  await screen.findByText("User saved.");
  expect(api.createUser).toHaveBeenCalledWith(expect.objectContaining({
    username: "child", role: "user",
    permissions: {
      all_libraries: false, library_ids: ["movies"], max_movie_rating: "PG-13",
      max_tv_rating: "TV-PG", allow_unrated: false,
      max_playback_streams: 5,
    },
  }));
});

it("keeps the saved password when editing and sends the revision", async () => {
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Edit Viewer" }));
  fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "New name" } });
  fireEvent.click(screen.getByRole("button", { name: "Save user" }));
  await waitFor(() => expect(api.updateUser).toHaveBeenCalledWith("u", expect.objectContaining({
    revision: 4, password: null, display_name: "New name",
  })));
});

it("creates an administrator with unlimited playback without changing library permissions", async () => {
  mount();
  fireEvent.click(screen.getByRole("button", { name: "Create user" }));
  fireEvent.change(screen.getByLabelText("Username"), { target: { value: "admin2" } });
  fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Admin two" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret1234" } });
  fireEvent.change(screen.getByLabelText("Role"), { target: { value: "admin" } });
  expect((screen.getByLabelText("Simultaneous playback limit") as HTMLInputElement).value).toBe("5");
  fireEvent.change(screen.getByLabelText("Simultaneous playback limit"), { target: { value: "0" } });
  fireEvent.click(screen.getByRole("button", { name: "Save user" }));
  await waitFor(() => expect(api.createUser).toHaveBeenCalledWith(expect.objectContaining({
    role: "admin", permissions: { ...account.permissions, max_playback_streams: 0 },
  })));
});

it("loads and edits an existing playback limit while preserving content restrictions", async () => {
  const permissions = { ...account.permissions, all_libraries: false, library_ids: ["movies"], max_movie_rating: "PG", max_tv_rating: "TV-PG", max_playback_streams: 3 };
  vi.mocked(api.users).mockResolvedValue([{ ...account, permissions }]);
  mount();fireEvent.click(await screen.findByRole("button", { name: "Edit Viewer" }));
  expect((screen.getByLabelText("Simultaneous playback limit") as HTMLInputElement).value).toBe("3");
  fireEvent.change(screen.getByLabelText("Simultaneous playback limit"), { target: { value: "0" } });
  fireEvent.click(screen.getByRole("button", { name: "Save user" }));
  await waitFor(() => expect(api.updateUser).toHaveBeenCalledWith("u", expect.objectContaining({
    permissions: { ...permissions, max_playback_streams: 0 }, revision: 4,
  })));
});

it("uses five streams for legacy accounts without a saved playback limit", async () => {
  mount();fireEvent.click(await screen.findByRole("button", { name: "Edit Viewer" }));
  expect((screen.getByLabelText("Simultaneous playback limit") as HTMLInputElement).value).toBe("5");
  fireEvent.click(screen.getByRole("button", { name: "Save user" }));
  await waitFor(() => expect(api.updateUser).toHaveBeenCalledWith("u", expect.objectContaining({
    permissions: { ...account.permissions, max_playback_streams: 5 },
  })));
});

it("requires deletion confirmation and reports last administrator protection", async () => {
  vi.mocked(api.deleteUser).mockRejectedValue(new Error("Keep one enabled administrator."));
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Delete Viewer" }));
  expect(api.deleteUser).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Confirm deletion" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Keep one enabled administrator.");
});
