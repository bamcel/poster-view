import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import ItemAbout, { providerLinks } from "./ItemAbout";
import type { ItemDetail } from "../types";
afterEach(cleanup);
const item: ItemDetail = { id: "show", title: "Series", type: "show", seasons: [], members: [], genres: ["Anime", "Action"], tags: ["Anti-Hero"], studios: ["WHITE FOX"], external_ids: { AniList: "20613", imdb: "tt123", tmdb: "42", MyAnimeList: "22199" } };
it("shows metadata and safe provider links with the current theme", () => {
  render(<ItemAbout item={item} />);
  for (const value of ["Genres", "Tags", "Studios", "Links", "Anime", "Anti-Hero", "WHITE FOX"]) expect(screen.getByText(value)).toBeTruthy();
  expect(screen.getByRole("link", { name: "AniList" }).getAttribute("href")).toBe("https://anilist.co/anime/20613");
  expect(screen.getByRole("link", { name: "TMDB" }).getAttribute("href")).toBe("https://www.themoviedb.org/tv/42");
  expect(screen.getByRole("link", { name: "MyAnimeList" }).getAttribute("rel")).toContain("noopener");
});
it("does not turn missing or invalid IDs into links and distinguishes movies", () => {
  expect(providerLinks({ ...item, type: "movie", external_ids: { tmdb: "42", imdb: "javascript:alert(1)", tvdb: "" } })).toEqual([{ label: "TMDB", href: "https://www.themoviedb.org/movie/42" }]);
  render(<ItemAbout item={{ ...item, genres: [], tags: [], studios: [], external_ids: {} }} />);
  expect(screen.getAllByText("Not provided")).toHaveLength(3);
  expect(screen.queryAllByRole("link")).toHaveLength(0);
});
it("uses server-provided links and rejects unsafe URL schemes", () => {
  const links = providerLinks({ ...item, external_urls: [{ name: "TMDB", url: "https://www.themoviedb.org/tv/42-example" }, { name: "Trakt", url: "https://trakt.tv/shows/example" }, { name: "Unsafe", url: "javascript:alert(1)" }] });
  expect(links.filter(link => link.label === "TMDB")).toEqual([{ label: "TMDB", href: "https://www.themoviedb.org/tv/42-example" }]);
  expect(links.some(link => link.label === "Trakt")).toBe(true);
  expect(links.some(link => link.label === "Unsafe")).toBe(false);
});
