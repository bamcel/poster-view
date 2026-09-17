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
  expect(screen.getAllByRole("button", { name: "Refresh artwork data" })).toHaveLength(1);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByRole("button", { name: "Refresh artwork data" })).toBeNull();
});

it("dismisses the menu when leaving the card without refreshing artwork", () => {
  const refresh = vi.fn();
  render(<PosterCard title="Movie" onOpen={vi.fn()} onRefresh={refresh} />);
  const card = screen.getByTitle("Movie · right-click for options");
  fireEvent.contextMenu(card);
  fireEvent.mouseLeave(card.parentElement!);
  expect(screen.queryByRole("button", { name: "Refresh artwork data" })).toBeNull();
  expect(refresh).not.toHaveBeenCalled();
});
