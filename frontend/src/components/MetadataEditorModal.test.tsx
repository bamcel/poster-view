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
