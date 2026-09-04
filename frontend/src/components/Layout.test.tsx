import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import AuthGate from "./AuthGate";
import Layout from "./Layout";
import { api } from "../api/client";

vi.mock("../api/client", () => ({ api: { authStatus: vi.fn() } }));
vi.mock("../lib/serverContext", () => ({ useServers: () => ({ servers: [], selectedId: null, setSelectedId: vi.fn() }) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it.each([true, false])("shows Sign out only when password_required is true (%s)", async (required) => {
  vi.mocked(api.authStatus).mockResolvedValue({ authenticated: true, password_required: required });
  render(<MemoryRouter><AuthGate><Layout /></AuthGate></MemoryRouter>);
  await screen.findAllByText("Settings");
  expect(screen.queryAllByRole("button", { name: "Sign out" })).toHaveLength(required ? 2 : 0);
});

it("updates both sign-out controls when the security policy changes", async () => {
  vi.mocked(api.authStatus).mockResolvedValue({ authenticated: true, password_required: true });
  render(<MemoryRouter><AuthGate><Layout /></AuthGate></MemoryRouter>);
  expect(await screen.findAllByRole("button", { name: "Sign out" })).toHaveLength(2);
  vi.mocked(api.authStatus).mockResolvedValue({ authenticated: true, password_required: false });
  fireEvent(window, new Event("posterview:security-changed"));
  await waitFor(() => expect(screen.queryAllByRole("button", { name: "Sign out" })).toHaveLength(0));
});
