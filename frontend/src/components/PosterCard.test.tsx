import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import PosterCard from "./PosterCard";

afterEach(cleanup);
it("keeps only the latest right-click menu open and dismisses it with Escape", () => {
  render(<>
    <PosterCard title="First" onOpen={vi.fn()} onRefresh={vi.fn()} />
    <PosterCard title="Second" onOpen={vi.fn()} onRefresh={vi.fn()} />
  </>);
  fireEvent.contextMenu(screen.getByTitle("First · right-click for options"));
  fireEvent.contextMenu(screen.getByTitle("Second · right-click for options"));
  expect(screen.getAllByRole("menuitem", { name: "Refresh artwork data" })).toHaveLength(1);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByRole("menuitem", { name: "Refresh artwork data" })).toBeNull();
});

it("dismisses the menu when leaving the card without refreshing artwork", () => {
  const refresh = vi.fn();
  render(<PosterCard title="Movie" onOpen={vi.fn()} onRefresh={refresh} />);
  const card = screen.getByTitle("Movie · right-click for options");
  fireEvent.contextMenu(card);
  fireEvent.mouseLeave(card.parentElement!);
  expect(screen.queryByRole("menuitem", { name: "Refresh artwork data" })).toBeNull();
  expect(refresh).not.toHaveBeenCalled();
});

it("opens options from the keyboard, focuses the action, and returns focus on Escape", () => {
  render(<PosterCard title="Movie" onOpen={vi.fn()} onRefresh={vi.fn()} />);
  const trigger = screen.getByTitle("Movie · right-click for options");
  fireEvent.keyDown(trigger, { key: "F10", shiftKey: true });
  const action = screen.getByRole("menuitem", { name: "Refresh artwork data" });
  expect(document.activeElement).toBe(action);
  fireEvent.keyDown(action, { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it("shows compact refresh and metadata actions and opens the editor action", () => {
  const editMetadata = vi.fn();
  render(<PosterCard title="Manga" onOpen={vi.fn()} onRefresh={vi.fn()} onEditMetadata={editMetadata} />);
  fireEvent.contextMenu(screen.getByTitle("Manga · right-click for options"));
  expect(screen.getByRole("menuitem", { name: "Refresh artwork data" }).className).toContain("whitespace-nowrap");
  fireEvent.click(screen.getByRole("menuitem", { name: "Edit Metadata" }));
  expect(editMetadata).toHaveBeenCalledOnce();
});
it("uses the same uppercase badge treatment for all tracking states", () => {
  const { rerender } = render(<PosterCard title="Book" badge="NEW" />);
  const appearance = screen.getByText("NEW").className;
  for (const status of ["Reading", "Finished"]) {
    rerender(<PosterCard title="Book" badge={status} />);
    expect(screen.getByText(status.toUpperCase()).className).toBe(appearance);
  }
  rerender(<PosterCard title="Season" badge={12} />);
  expect(screen.getByText("12")).toBeTruthy();
});
