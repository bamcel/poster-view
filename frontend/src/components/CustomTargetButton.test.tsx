import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import CustomTargetButton from "./CustomTargetButton";

afterEach(cleanup);

it("supports keyboard navigation and restores focus when the target menu closes", () => {
  render(<CustomTargetButton item={{ id: "one", title: "Movie", type: "movie", seasons: [], external_ids: {}, members: [] }} onPick={vi.fn()} />);
  const trigger = screen.getByRole("button", { name: "Custom" });
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  const actions = screen.getAllByRole("menuitem");
  expect(document.activeElement).toBe(actions[0]);
  fireEvent.keyDown(actions[0], { key: "End" });
  expect(document.activeElement).toBe(actions.at(-1));
  fireEvent.keyDown(actions.at(-1)!, { key: "Home" });
  expect(document.activeElement).toBe(actions[0]);
  fireEvent.keyDown(actions[0], { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull();
  expect(document.activeElement).toBe(trigger);
});
