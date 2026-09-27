import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import ProviderConnection, { providerStatus } from "./ProviderConnection";

afterEach(() => { cleanup(); sessionStorage.clear(); });
it("remembers expansion and keeps credentials hidden until opened", () => {
  const props = { id: "test", name: "Test", description: "Artwork", status: "Credentials saved", setupUrl: "https://example.com" };
  const first = render(<ProviderConnection {...props}><input aria-label="API key" /></ProviderConnection>);
  expect(screen.queryByRole("textbox")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Configure Test" }));
  expect(screen.getByRole("textbox", { name: "API key" })).toBeTruthy();
  expect(screen.queryByRole("img")).toBeNull();
  first.unmount();
  render(<ProviderConnection {...props} status="Connection verified"><input aria-label="API key" /></ProviderConnection>);
  expect(screen.getByRole("button", { name: "Configure Test" }).getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByRole("img", { name: "Test connection verified" })).toBeTruthy();
});
it("distinguishes saved credentials from connection verification", () => {
  expect(providerStatus(true)).toBe("Credentials saved");
  expect(providerStatus(true, true)).toBe("Testing…");
  expect(providerStatus(true, false, { ok: true })).toBe("Connection verified");
  expect(providerStatus(true, false, { ok: false })).toBe("Connection failed");
  expect(providerStatus(false)).toBe("Not configured");
});
