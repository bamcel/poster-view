import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import MetadataEditorModal from "./MetadataEditorModal";
import type { NfoMetadata } from "../types";

afterEach(cleanup);

const metadata = (values: Partial<NfoMetadata> = {}): NfoMetadata => ({
  title: "", year: "", publisher: "", edition: "", volumes: "", status: "", plot: "",
  anilist_id: "", comicvine_id: "", source_url: "", native_title: "", mal_id: "",
  genres: "", tags: "", creators: "", country: "", source_material: "", ...values,
});

it("keeps existing conflicts until the user chooses imported fields", () => {
  const save = vi.fn();
  render(
    <MetadataEditorModal
      metadata={metadata({ title: "Existing title", year: "2024" })}
      incoming={metadata({ title: "Imported title", year: "2017", publisher: "Publisher" })}
      sourceLabel="AniList"
      saving={false}
      onClose={vi.fn()}
      onSave={save}
    />,
  );

  expect(screen.getByDisplayValue("Existing title")).toBeTruthy();
  expect(screen.getByDisplayValue("Publisher")).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox", { name: /Overwrite Year/ }));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(save).toHaveBeenCalledWith(expect.objectContaining({
    title: "Existing title",
    year: "2017",
    publisher: "Publisher",
  }));
});

it("keeps existing and imported provider source URLs together", () => {
  const save = vi.fn();
  render(
    <MetadataEditorModal
      metadata={metadata({ title: "The Apothecary Diaries", source_url: "https://anilist.co/manga/99022" })}
      incoming={metadata({ source_url: "https://comicvine.gamespot.com/volume/4050-132428/" })}
      sourceLabel="ComicVine"
      saving={false}
      onClose={vi.fn()}
      onSave={save}
    />,
  );

  expect(screen.getByRole("link", { name: /AniList/ })).toBeTruthy();
  expect(screen.getByRole("link", { name: /ComicVine/ })).toBeTruthy();
  expect(screen.getByLabelText("AniList URL")).toBeTruthy();
  expect(screen.getByLabelText("ComicVine URL")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(save).toHaveBeenCalledWith(expect.objectContaining({
    source_url: "https://anilist.co/manga/99022\nhttps://comicvine.gamespot.com/volume/4050-132428/",
  }));
});
