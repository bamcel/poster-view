import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AuthGate from "./AuthGate";
import { api } from "../api/client";

vi.mock("../api/client", () => ({
  api: {
    authStatus: vi.fn(),
    authLogin: vi.fn(),
  },
}));

describe("AuthGate", () => {
  afterEach(cleanup);

  beforeEach(() => {
    vi.mocked(api.authStatus).mockReset();
    vi.mocked(api.authLogin).mockReset();
  });

  it("renders protected content for an authenticated session", async () => {
    vi.mocked(api.authStatus).mockResolvedValue({ authenticated: true });
    render(<AuthGate><div>Protected library</div></AuthGate>);
    expect(await screen.findByText("Protected library")).toBeTruthy();
  });

  it("signs in and reveals protected content", async () => {
    vi.mocked(api.authStatus).mockResolvedValue({ authenticated: false });
    vi.mocked(api.authLogin).mockResolvedValue({ authenticated: true });
    render(<AuthGate><div>Protected library</div></AuthGate>);

    fireEvent.change(await screen.findByLabelText("Password"), {
      target: { value: "correct-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(api.authLogin).toHaveBeenCalledWith("correct-password"));
    expect(await screen.findByText("Protected library")).toBeTruthy();
  });
});
