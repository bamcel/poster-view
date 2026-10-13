import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AuthGate from "./AuthGate";
import { api } from "../api/client";
import { initialUsername, setRememberUsername } from "../lib/rememberUsername";

vi.mock("../api/client", () => ({
  api: {
    authStatus: vi.fn(),
    authLogin: vi.fn(),
    authSetup: vi.fn(),
  },
}));

afterEach(cleanup);

describe("AuthGate", () => {
  afterEach(cleanup);

  beforeEach(() => {
    localStorage.clear();
    vi.mocked(api.authStatus).mockReset();
    vi.mocked(api.authLogin).mockReset();
  });

  it("renders protected content for an authenticated session", async () => {
    vi.mocked(api.authStatus).mockResolvedValue({ authenticated: true });
    render(<AuthGate><div>Protected library</div></AuthGate>);
    expect(await screen.findByText("Protected library")).toBeTruthy();
  });

  it("uses the container username instead of stale remembered admin without replacing edits", async () => {
    localStorage.setItem("posterview.savedUsername", "admin");
    vi.mocked(api.authStatus).mockResolvedValue({ authenticated: false, username: "curator" });
    render(<AuthGate><div>Protected library</div></AuthGate>);
    const input = await screen.findByLabelText("Username") as HTMLInputElement;
    expect(input.value).toBe("curator");
    fireEvent.change(input, { target: { value: "my-edit" } });
    fireEvent(window, new Event("posterview:security-changed"));
    await waitFor(() => expect(api.authStatus).toHaveBeenCalledTimes(2));
    expect(input.value).toBe("my-edit");
  });

  it("does not prefill the container username when remembering is disabled", async () => {
    setRememberUsername(false);
    vi.mocked(api.authStatus).mockResolvedValue({ authenticated: false, username: "curator" });
    render(<AuthGate><div>Protected library</div></AuthGate>);
    expect((await screen.findByLabelText("Username") as HTMLInputElement).value).toBe("");
  });

  it("signs in and reveals protected content", async () => {
    vi.mocked(api.authStatus).mockResolvedValue({ authenticated: false });
    vi.mocked(api.authLogin).mockResolvedValue({ authenticated: true });
    render(<AuthGate><div>Protected library</div></AuthGate>);

    fireEvent.change(await screen.findByLabelText("Password"), {
      target: { value: "correct-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(api.authLogin).toHaveBeenCalledWith("admin", "correct-password"));
    expect(await screen.findByText("Protected library")).toBeTruthy();
  });

  it("keeps a successful username after sign-out and reload, but clears the password", async () => {
    vi.mocked(api.authStatus).mockResolvedValue({ authenticated: false });
    vi.mocked(api.authLogin).mockResolvedValue({ authenticated: true });
    const view = render(<AuthGate><div>Protected library</div></AuthGate>);
    fireEvent.change(await screen.findByLabelText("Username"), { target: { value: "curator" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByText("Protected library");
    expect(api.authLogin).toHaveBeenCalledWith("curator", "secret");
    fireEvent(window, new Event("posterview:unauthorized"));
    expect((await screen.findByLabelText("Username") as HTMLInputElement).value).toBe("curator");
    expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe("");
    view.unmount();
    render(<AuthGate><div>Protected library</div></AuthGate>);
    expect((await screen.findByLabelText("Username") as HTMLInputElement).value).toBe("curator");
    expect(JSON.stringify(localStorage)).not.toContain("secret");
  });

  it("does not remember unsuccessful logins or usernames when remembering is off", async () => {
    setRememberUsername(false);
    vi.mocked(api.authStatus).mockResolvedValue({ authenticated: false });
    vi.mocked(api.authLogin).mockRejectedValueOnce(new Error("Incorrect username or password."));
    vi.mocked(api.authLogin).mockResolvedValueOnce({ authenticated: true });
    render(<AuthGate><div>Protected library</div></AuthGate>);
    expect((await screen.findByLabelText("Username") as HTMLInputElement).value).toBe("");
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "curator" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByRole("alert");
    expect(initialUsername()).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByText("Protected library");
    expect(initialUsername()).toBe("");
    fireEvent(window, new Event("posterview:unauthorized"));
    expect((await screen.findByLabelText("Username") as HTMLInputElement).value).toBe("");
  });
});

it("does not substitute a bootstrap username for multi-account sign in and clears data on login",async()=>{
 localStorage.clear();vi.mocked(api.authStatus).mockResolvedValue({authenticated:false,accounts_enabled:true,username:"admin"});vi.mocked(api.authLogin).mockResolvedValue({authenticated:true,accounts_enabled:true});
 const changed=vi.fn();window.addEventListener("posterview:account-changed",changed);
 render(<AuthGate><p>Viewer home</p></AuthGate>);
 const username=await screen.findByLabelText("Username");expect((username as HTMLInputElement).value).toBe("");fireEvent.change(username,{target:{value:"viewer"}});fireEvent.change(screen.getByLabelText("Password"),{target:{value:"secret1234"}});fireEvent.click(screen.getByRole("button",{name:"Sign in"}));await screen.findByText("Viewer home");expect(changed).toHaveBeenCalled();window.removeEventListener("posterview:account-changed",changed);
});

it("removes the previous account's cached catalog on expiration",async()=>{
 const client=new QueryClient();client.setQueryData(["native-catalog","private"],[{title:"Private film"}]);vi.mocked(api.authStatus).mockResolvedValue({authenticated:true});render(<QueryClientProvider client={client}><AuthGate><p>Signed in</p></AuthGate></QueryClientProvider>);await screen.findByText("Signed in");fireEvent(window,new Event("posterview:unauthorized"));await screen.findByRole("button",{name:"Sign in"});expect(client.getQueryData(["native-catalog","private"])).toBeUndefined();
});


it("requires a first administrator before showing the app and signs into the new account", async () => {
  localStorage.clear();
  vi.mocked(api.authStatus).mockResolvedValue({ authenticated: false, setup_required: true });
  vi.mocked(api.authSetup).mockResolvedValue({ authenticated: true, setup_required: false });
  const client = new QueryClient();
  client.setQueryData(["native-libraries"], [{ id: "previous-account" }]);
  render(
    <QueryClientProvider client={client}>
      <AuthGate><p>Administrator home</p></AuthGate>
    </QueryClientProvider>,
  );
  expect(await screen.findByRole("heading", { name: "Create administrator" })).toBeTruthy();
  expect(screen.queryByText("Administrator home")).toBeNull();
  expect((screen.getByLabelText("Username") as HTMLInputElement).value).toBe("");
  fireEvent.change(screen.getByLabelText("Username"), { target: { value: "owner" } });
  fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Server owner" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "strong-password" } });
  fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "strong-password" } });
  fireEvent.click(screen.getByRole("button", { name: "Create administrator" }));
  await screen.findByText("Administrator home");
  expect(api.authSetup).toHaveBeenCalledWith("owner", "Server owner", "strong-password");
  expect(client.getQueryData(["native-libraries"])).toBeUndefined();
});

it("validates setup confirmation and keeps server setup errors visible", async () => {
  localStorage.clear();
  vi.mocked(api.authSetup).mockReset();
  vi.mocked(api.authStatus).mockResolvedValue({ authenticated: false, setup_required: true });
  vi.mocked(api.authSetup).mockRejectedValue(new Error("Administrator already created. Reload to sign in."));
  render(<AuthGate><p>Administrator home</p></AuthGate>);
  await screen.findByRole("heading", { name: "Create administrator" });
  fireEvent.change(screen.getByLabelText("Username"), { target: { value: "owner" } });
  fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Server owner" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "strong-password" } });
  fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "wrong-password" } });
  fireEvent.click(screen.getByRole("button", { name: "Create administrator" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Passwords do not match.");
  expect(api.authSetup).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "strong-password" } });
  fireEvent.click(screen.getByRole("button", { name: "Create administrator" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Administrator already created.");
  expect(screen.queryByText("Administrator home")).toBeNull();
});
