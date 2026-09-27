import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import TitleMetadata from "./TitleMetadata";
import type { ItemDetail } from "../types";
afterEach(cleanup);
const item: ItemDetail = { id: "show", title: "Series", type: "show", seasons: [], members: [], external_ids: {}, year: 2015, rating: 7.9, studios: ["Fuji TV", "Other studio"], season_count: 2, content_rating: "TV-14", genres: ["Action", "Comedy"] };
it("shows the compact information row in the requested order", () => {
  render(<TitleMetadata item={item} />);
  expect(screen.getByLabelText("Title information").textContent).toBe("7.92015Fuji TV2 SeasonsTV-14Action");
  expect(screen.getByLabelText("Rating 7.9 out of 10")).toBeTruthy();
  expect(screen.queryByText("Other studio")).toBeNull();
});
it("omits missing fields and does not display seasons on movies", () => {
  render(<TitleMetadata item={{ ...item, type: "movie", rating: null, content_rating: null, genres: [], studios: [] }} />);
  expect(screen.getByLabelText("Title information").textContent).toBe("2015");
});
