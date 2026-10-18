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
  await waitFor(() => expect(api.updateUser).toHaveBeenCalledWith("u", expect.objectContaining({
    permissions: { ...permissions, max_playback_streams: 0 }, revision: 4,
  })));
});

it("uses five streams for legacy accounts without writing on open", async () => {
 mount();fireEvent.click(await screen.findByRole("button",{name:"Edit Viewer"}));
 expect((screen.getByLabelText("Simultaneous playback limit") as HTMLInputElement).value).toBe("5");
 expect(screen.queryByRole("button",{name:"Save user"})).toBeNull();
 expect(api.updateUser).not.toHaveBeenCalled();
});

it("requires deletion confirmation and reports last administrator protection", async () => {
  vi.mocked(api.deleteUser).mockRejectedValue(new Error("Keep one enabled administrator."));
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Delete Viewer" }));
  expect(api.deleteUser).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Confirm deletion" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Keep one enabled administrator.");
});


it("opens a modal editor, traps keyboard focus and restores the triggering control", async () => {
  mount();
  const edit = await screen.findByRole("button", { name: "Edit Viewer" });
  edit.focus();
  fireEvent.click(edit);
  const dialog = screen.getByRole("dialog", { name: "Edit Viewer" });
  expect(dialog.getAttribute("aria-modal")).toBe("true");
  expect(document.activeElement).toBe(screen.getByLabelText("Username"));
  const cancel = screen.getByRole("button", { name: /^Cancel$/ });
  cancel.focus();
  fireEvent.keyDown(cancel, { key: "Tab" });
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close user editor" }));
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(edit);
  expect(api.updateUser).not.toHaveBeenCalled();
});

it("keeps save failures inside the editor and closes without saving", async () => {
  vi.mocked(api.updateUser).mockRejectedValueOnce(new Error("Revision changed."));
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Edit Viewer" }));
  fireEvent.change(screen.getByLabelText("Display name"),{target:{value:"Changed"}});
  const alert = await screen.findByRole("alert");
  expect(screen.getByRole("dialog").contains(alert)).toBe(true);
  await waitFor(()=>expect((screen.getByRole("button",{name:"Close user editor"}) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Close user editor" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("autosaves account settings without sending a password draft and advances revisions",async()=>{
 vi.mocked(api.updateUser).mockResolvedValue({...account,revision:5});
 mount();fireEvent.click(await screen.findByRole("button",{name:"Edit Viewer"}));
 fireEvent.change(screen.getByLabelText("New password (leave blank to keep current)"),{target:{value:"new-password"}});
 fireEvent.change(screen.getByLabelText("Display name"),{target:{value:"Changed"}});
 await waitFor(()=>expect(api.updateUser).toHaveBeenCalledWith("u",expect.objectContaining({password:null,revision:4,display_name:"Changed"})));
 expect(await screen.findByText("Changes saved automatically")).toBeTruthy();
 fireEvent.change(screen.getByLabelText("Display name"),{target:{value:"Changed again"}});
 await waitFor(()=>expect(api.updateUser).toHaveBeenLastCalledWith("u",expect.objectContaining({password:null,revision:5,display_name:"Changed again"})));
 await screen.findByText("Changes saved automatically");
 fireEvent.click(screen.getByRole("button",{name:"Update password"}));
 await waitFor(()=>expect(api.updateUser).toHaveBeenLastCalledWith("u",expect.objectContaining({password:"new-password",revision:5})));
});

it("keeps the user editor open while automatic saves are pending and in flight",async()=>{
 let complete!:(account:UserAccount)=>void;
 vi.mocked(api.updateUser).mockImplementationOnce(()=>new Promise(resolve=>{complete=resolve;}));
 mount();fireEvent.click(await screen.findByRole("button",{name:"Edit Viewer"}));
 fireEvent.change(screen.getByLabelText("Display name"),{target:{value:"Changed"}});
 await waitFor(()=>expect((screen.getByRole("button",{name:"Close user editor"}) as HTMLButtonElement).disabled).toBe(true));
 fireEvent.keyDown(screen.getByRole("dialog"),{key:"Escape"});
 expect(screen.getByRole("dialog")).toBeTruthy();
 await waitFor(()=>expect(api.updateUser).toHaveBeenCalled());
 fireEvent.click(screen.getByRole("button",{name:"Cancel"}));
 expect(screen.getByRole("dialog")).toBeTruthy();
 complete({...account,revision:5});
 await screen.findByText("Changes saved automatically");
 await waitFor(()=>expect((screen.getByRole("button",{name:"Close user editor"}) as HTMLButtonElement).disabled).toBe(false));
});

it("prevents account edits from racing an explicit password update",async()=>{
 let complete!:(account:UserAccount)=>void;
 vi.mocked(api.updateUser).mockImplementationOnce(()=>new Promise(resolve=>{complete=resolve;}));
 mount();fireEvent.click(await screen.findByRole("button",{name:"Edit Viewer"}));
 fireEvent.change(screen.getByLabelText("New password (leave blank to keep current)"),{target:{value:"replacement-password"}});
 fireEvent.click(screen.getByRole("button",{name:"Update password"}));
 await waitFor(()=>expect(api.updateUser).toHaveBeenCalledTimes(1));
 expect(screen.getByLabelText("Display name").closest("fieldset")?.disabled).toBe(true);
 expect((screen.getByRole("button",{name:"Close user editor"}) as HTMLButtonElement).disabled).toBe(true);
 complete({...account,revision:5});
 await screen.findByText("Password updated.");
 expect(screen.getByLabelText("Display name").closest("fieldset")?.disabled).toBe(false);
});
