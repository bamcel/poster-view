import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import DetailSynopsis from "./DetailSynopsis";
afterEach(cleanup);
it("renders provider markup as text and expands the description", () => {
  const { container } = render(<DetailSynopsis text={'First &amp; second<br>Next <b>paragraph</b><script>alert(1)</script>'} />);
  expect(container.querySelector("p")?.textContent).toBe("First & second\nNext paragraph");
  expect(container.querySelector("script")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "More" }));
  expect(screen.getByRole("button", { name: "Less" }).getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Less" }));
  expect(screen.getByRole("button", { name: "More" }).getAttribute("aria-expanded")).toBe("false");
});

it("collapses repeated provider breaks while keeping single newlines", () => {
  const { container } = render(<DetailSynopsis text={'First<br><br>\n  <br>Second\n\n\nThird'} />);
  expect(container.querySelector("p")?.textContent).toBe("First\nSecond\nThird");
});
