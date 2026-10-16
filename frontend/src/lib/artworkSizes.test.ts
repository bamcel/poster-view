import {expect, it} from "vitest";
import {sizedArtwork} from "./artworkSizes";

const url = "/api/native/libraries/lib/items/title/artwork/poster";
it("quantizes requests to bounded widths and replaces existing sizes", () => {
  expect(sizedArtwork(url, 200)).toBe(`${url}?width=320`);
  expect(sizedArtwork(`${url}?width=96&width=480`, 5000)).toBe(`${url}?width=1920`);
});
it("preserves source versions, format, still frames and framing metadata", () => {
  const query = "v=abc%2F123&format=gif&still=1&backdropEdit=%7B%22x%22%3A50%7D";
  expect(sizedArtwork(`${url}?${query}#preview`, 192)).toBe(`${url}?${query}&width=192#preview`);
});
it("leaves provider URLs and invalid size requests untouched", () => {
  for (const source of ["https://image.tmdb.org/poster.jpg", "https://example.com" + url, "/api/native/libraries/lib/items/title", ""]) expect(sizedArtwork(source, 480)).toBe(source);
  for (const width of [0, -1, NaN, Infinity]) expect(sizedArtwork(url, width)).toBe(url);
});
