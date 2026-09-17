import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./client";

describe("API client authentication", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps server context on every PosterDB cache request", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(
      new Response(JSON.stringify({}), { status: 200 }),
    ));
    vi.stubGlobal("fetch", fetchMock);
    await api.posterdbSearch(7, "House & Home");
    await api.posterdbSearchPreview(8, "House & Home");
    await api.posterdbSet(7, "https://theposterdb.com/set/1");
    await api.posterdbVerify(8, ["1"]);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/posterdb/search?server_id=7&term=House%20%26%20Home",
      "/api/posterdb/search/preview?server_id=8&term=House%20%26%20Home",
      "/api/posterdb/set?server_id=7&url=https%3A%2F%2Ftheposterdb.com%2Fset%2F1",
      "/api/posterdb/verify?server_id=8",
    ]);
  });

  it("sends both username and password to the login endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ authenticated: true })));
    vi.stubGlobal("fetch", fetchMock);
    await api.authLogin("admin", "test-password");
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/login", expect.objectContaining({
      method: "POST", body: JSON.stringify({ username: "admin", password: "test-password" }),
    }));
  });

  it("reads authentication status from the public endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ authenticated: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.authStatus()).resolves.toEqual({ authenticated: true });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/status",
      expect.objectContaining({ headers: { "Content-Type": "application/json" } }),
    );
  });

  it("announces an expired session on a 401 response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: "Authentication required." }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    ));
    const listener = vi.fn();
    window.addEventListener("posterview:unauthorized", listener);

    await expect(api.listServers()).rejects.toEqual(
      expect.objectContaining({ status: 401, message: "Authentication required." }),
    );
    expect(listener).toHaveBeenCalledOnce();
    window.removeEventListener("posterview:unauthorized", listener);
  });
});
