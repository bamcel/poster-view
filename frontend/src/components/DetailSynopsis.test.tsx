import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import DetailSynopsis from "./DetailSynopsis";
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
function clipped(){
 vi.spyOn(HTMLElement.prototype,"scrollHeight","get").mockReturnValue(300);
 vi.spyOn(HTMLElement.prototype,"clientHeight","get").mockReturnValue(72);
}

it("renders provider markup as text and expands the description", () => {
  clipped();
  const { container } = render(<DetailSynopsis text={'First &amp; second<br>Next <b>paragraph</b><script>alert(1)</script>'} />);
  expect(container.querySelector("p")?.textContent).toBe("First & second\nNext paragraph");
  expect(container.querySelector("script")).toBeNull();
  container.querySelector("p")!.style.lineHeight="24px";
  fireEvent.click(screen.getByRole("button", { name: "More" }));
  expect(screen.getByRole("button", { name: "Less" }).getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Less" }));
  expect(screen.getByRole("button", { name: "More" }).getAttribute("aria-expanded")).toBe("false");
});

it("collapses repeated provider breaks while keeping single newlines", () => {
  const { container } = render(<DetailSynopsis text={'First<br><br>\n  <br>Second\n\n\nThird'} />);
  expect(container.querySelector("p")?.textContent).toBe("First\nSecond\nThird");
});

it("uses eight lines for series and converts escaped break tags",()=>{
 clipped();
 const {container}=render(<DetailSynopsis lines={8} text="First&lt;br /&gt;Second<BR/>Third"/>);
 const paragraph=container.querySelector("p")!;
 expect(paragraph.textContent).toBe("First\nSecond\nThird");
 expect(paragraph.className).toContain("line-clamp-[8]");
 expect(paragraph.className).toContain("whitespace-pre-line");
 paragraph.style.lineHeight="24px";
 fireEvent.click(screen.getByRole("button",{name:"More"}));
 expect(paragraph.className).not.toContain("line-clamp-[8]");
});

it("hides More when all text fits and hides bracket-only descriptions",()=>{
 const view=render(<DetailSynopsis text="Short description [Written by MAL Rewrite]"/>);
 expect(screen.getByText("Short description")).toBeTruthy();
 expect(screen.queryByRole("button",{name:"More"})).toBeNull();
 view.rerender(<DetailSynopsis text="[Only a provider note]"/>);
 expect(view.container.textContent).toBe("");
});
it("remeasures clipping when the viewport changes",()=>{
 let height=60;
 vi.spyOn(HTMLElement.prototype,"scrollHeight","get").mockImplementation(()=>height);
 vi.spyOn(HTMLElement.prototype,"clientHeight","get").mockReturnValue(60);
 render(<DetailSynopsis text="A responsive synopsis"/>);
 expect(screen.queryByRole("button",{name:"More"})).toBeNull();
 height=120;fireEvent.resize(window);
 expect(screen.getByRole("button",{name:"More"})).toBeTruthy();
 height=60;fireEvent.resize(window);
 expect(screen.queryByRole("button",{name:"More"})).toBeNull();
});
