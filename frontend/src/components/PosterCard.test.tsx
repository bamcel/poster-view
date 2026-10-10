import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import PosterCard from "./PosterCard";

afterEach(cleanup);
it("colors title text independently from the badge", () => {
  const { rerender } = render(<PosterCard title="Colored Title" coloredTitle />);
  expect(screen.getByText("Colored Title").classList.contains("poster-colored-title")).toBe(true);
  expect(screen.getByText("Colored Title").classList.contains("poster-colored-badge")).toBe(false);
  expect(screen.queryByText("COLORED")).toBeNull();
  rerender(<PosterCard title="Colored Title" coloredEffect="badge" />);
  expect(screen.getByText("Colored Title").classList.contains("poster-colored-title")).toBe(false);
  expect(screen.getByText("COLORED")).toBeTruthy();
});
it("selects from the hover control without opening the series", () => {
  const open = vi.fn(); const select = vi.fn();
  const { rerender } = render(<PosterCard title="Series" onOpen={open} onSelect={select} />);
  fireEvent.click(screen.getByRole("button", { name: "Select Series" }), { shiftKey: true });
  expect(select).toHaveBeenCalledWith(true); expect(open).not.toHaveBeenCalled();
  rerender(<PosterCard title="Series" onOpen={open} onSelect={select} selectionMode selected />);
  expect(screen.getByRole("button", { name: "Select Series" }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(screen.getByTitle("Series"));
  expect(select).toHaveBeenCalledWith(false); expect(open).not.toHaveBeenCalled();
});
it("keeps the mobile selection control square while preserving its compact desktop size", () => {
  render(<PosterCard title="Series" onOpen={vi.fn()} onSelect={vi.fn()} />);
  const selector = screen.getByRole("button", { name: "Select Series" });
  expect(selector.className).toContain("size-11");
  expect(selector.className).toContain("min-h-11");
  expect(selector.className).toContain("min-w-11");
  expect(selector.className).toContain("md:size-7");
  expect(selector.className).toContain("md:min-h-7");
  expect(selector.className).toContain("md:min-w-7");
});
it("renders both colored effects together", () => {
  const { container } = render(<PosterCard title="Book" image="poster.jpg" coloredEffect="both" />);
  expect(container.querySelector(".poster-colored-shimmer")).toBeTruthy();
  expect(screen.getByText("COLORED")).toBeTruthy();
});
it("gives each poster a stable random shimmer phase", () => {
  const random = vi.spyOn(Math, "random").mockReturnValueOnce(0.2).mockReturnValueOnce(0.8);
  const { container, rerender } = render(<><PosterCard title="First" image="first.jpg" coloredEffect="shimmer" /><PosterCard title="Second" image="second.jpg" coloredEffect="shimmer" /></>);
  const delays = () => Array.from(container.querySelectorAll<HTMLElement>(".poster-colored-shimmer")).map(element => element.style.animationDelay);
  const initial = delays();
  expect(initial[0]).not.toBe(initial[1]);
  rerender(<><PosterCard title="First updated" image="first.jpg" coloredEffect="shimmer" /><PosterCard title="Second" image="second.jpg" coloredEffect="shimmer" /></>);
  expect(delays()).toEqual(initial);
  random.mockRestore();
});
it("keeps colored effects opt-in and separate from progress badges", () => {
  const { container, rerender } = render(<PosterCard title="Book [Colored]" image="poster.jpg" />);
  expect(container.querySelector(".poster-colored-shimmer")).toBeNull();
  expect(screen.queryByText("COLORED")).toBeNull();
  rerender(<PosterCard title="Book" image="poster.jpg" coloredEffect="shimmer" />);
  expect(container.querySelector(".poster-colored-shimmer")).toBeTruthy();
  rerender(<PosterCard title="Book" image="poster.jpg" coloredEffect="badge" badge="Reading" />);
  expect(screen.getByText("COLORED")).toBeTruthy();
  expect(screen.getByText("READING")).toBeTruthy();
  expect(container.querySelector(".poster-colored-shimmer")).toBeNull();
});
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

it("supports a folder scan menu without requiring artwork actions",()=>{
 const scan=vi.fn();render(<PosterCard title="Series" onScan={scan} onOpen={vi.fn()}/>);
 fireEvent.contextMenu(screen.getByTitle("Series · right-click for options"));
 fireEvent.click(screen.getByRole("menuitem",{name:"Scan library files"}));
 expect(scan).toHaveBeenCalledTimes(1);
 expect(screen.queryByRole("menuitem",{name:"Scan library files"})).toBeNull();
});

it("uses a still frame for animated context menu previews",()=>{
 const src="/api/native/libraries/library/items/show/artwork/poster-animated?format=webm";
 render(<PosterCard title="Series" image="/static.jpg" menuImage={src} onOpen={vi.fn()} onScan={vi.fn()}/>);
 fireEvent.contextMenu(screen.getByTitle("Series · right-click for options"));
 const menu=screen.getByRole("menu");
 expect(menu.querySelector("img")?.getAttribute("src")).toBe(src+"&still=1");
 expect(menu.querySelector("video")).toBeNull();
});
