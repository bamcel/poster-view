import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import CreditCarousel from "./CreditCarousel";
import type { DisplayCredit } from "../lib/credits";
afterEach(cleanup);
it("scrolls wheel input horizontally and releases it at the row boundary", () => {
  const credit = { person_id: "1", name: "Actor", character: "Hero", category: "cast", role: "Voice", sources: [] } as unknown as DisplayCredit;
  render(<CreditCarousel credits={[credit]} characters={false} label="Japanese Cast" />);
  const row = screen.getByRole("region", { name: "Japanese Cast carousel" });
  Object.defineProperties(row, { scrollWidth: { value: 1000 }, clientWidth: { value: 200 } });
  const wheel = new WheelEvent("wheel", { deltaY: 100, bubbles: true, cancelable: true });
  fireEvent(row, wheel);
  expect(row.scrollLeft).toBe(100); expect(wheel.defaultPrevented).toBe(true);
  row.scrollLeft = 800;
  const boundary = new WheelEvent("wheel", { deltaY: 100, bubbles: true, cancelable: true });
  fireEvent(row, boundary); expect(boundary.defaultPrevented).toBe(false);
  row.scrollLeft = 100; fireEvent.scroll(row);
  row.scrollBy = vi.fn();
  fireEvent.click(screen.getByRole("button", { name: "Next Japanese Cast" }));
  expect(row.scrollBy).toHaveBeenCalledWith(expect.objectContaining({ left: 160 }));
});

it("overlays character portraits only for animation cast and hides broken images", () => {
  const credit = { person_id: "1", name: "Actor", character: "Hero", character_image: "https://example.com/hero.jpg", category: "cast", role: "Voice", sources: [] } as unknown as DisplayCredit;
  const { rerender } = render(<CreditCarousel credits={[credit]} characters={false} label="Cast" showCharacterPortraits />);
  const portrait = screen.getByAltText("Hero character portrait");
  expect(portrait.getAttribute("src")).toBe(credit.character_image);
    expect(portrait.className).toContain("w-[18%]");
  fireEvent.error(portrait);
  expect(portrait.style.display).toBe("none");
  rerender(<CreditCarousel credits={[credit]} characters={false} label="Cast" />);
  expect(screen.queryByAltText("Hero character portrait")).toBeNull();
  rerender(<CreditCarousel credits={[{ ...credit, category: "crew" }]} characters={false} label="Crew" showCharacterPortraits />);
  expect(screen.queryByAltText("Hero character portrait")).toBeNull();
  rerender(<CreditCarousel credits={[credit]} characters label="Characters" showCharacterPortraits />);
  expect(screen.queryByAltText("Hero character portrait")).toBeNull();
});
