import {act, cleanup, fireEvent, render, screen} from "@testing-library/react";
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import CharacterHoverCard from "./CharacterHoverCard";

function mount(person: Record<string, unknown> = {name: "Maomao", role: "MAIN", biography: "An **apothecary**.<br>~!Hidden identity!~[Her work](https://example.com)"}) {
  return render(<CharacterHoverCard person={person} portrait={<img src="/portrait.jpg" alt="Maomao portrait"/>}><p>Character tile</p></CharacterHoverCard>);
}
const anchor = () => screen.getByText("Character tile").parentElement!;
beforeEach(() => {vi.useFakeTimers(); vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({left: 900, top: 300, width: 192, height: 300, right: 1092, bottom: 600, x: 900, y: 300, toJSON() {}});});
afterEach(() => {cleanup(); vi.useRealTimers(); vi.restoreAllMocks();});
it("delays a portal preview, bounds it to the viewport and safely formats its biography", () => {
  const view = mount(); fireEvent.mouseEnter(anchor()); act(() => vi.advanceTimersByTime(349)); expect(screen.queryByRole("region")).toBeNull();
  act(() => vi.advanceTimersByTime(1)); const panel = screen.getByRole("region", {name: "Profile of Maomao"});
  expect(view.container.contains(panel)).toBe(false); expect(Number.parseFloat(panel.style.left) + 360).toBeLessThanOrEqual(window.innerWidth - 12);
  expect(screen.getByText("An apothecary. Her work", {exact: false}).textContent).toBe("An apothecary.\nHer work"); expect(panel.textContent).not.toContain("Hidden identity");
  expect(screen.getByRole("img", {name: "Maomao portrait"})).toBeTruthy(); expect(screen.getByText("main")).toBeTruthy(); expect(panel.querySelector("a")).toBeNull();
});
it("bridges pointer movement to the floating card and closes only after leaving both", () => {
  mount(); fireEvent.mouseEnter(anchor()); act(() => vi.advanceTimersByTime(350)); fireEvent.mouseLeave(anchor()); act(() => vi.advanceTimersByTime(100));
  fireEvent.mouseEnter(screen.getByRole("region")); act(() => vi.advanceTimersByTime(500)); expect(screen.getByRole("region")).toBeTruthy();
  fireEvent.mouseLeave(screen.getByRole("region")); act(() => vi.advanceTimersByTime(180)); expect(screen.queryByRole("region")).toBeNull();
});
it("opens on focus, lets keyboard users enter the card and restores focus on Escape", () => {
  mount(); const trigger = screen.getByRole("button", {name: "Preview Maomao"}); act(() => trigger.focus()); expect(screen.getByRole("region")).toBeTruthy();
  fireEvent.keyDown(trigger, {key: "Tab"}); expect(document.activeElement).toBe(screen.getByRole("button", {name: "Close profile of Maomao"}));
  fireEvent.keyDown(window, {key: "Escape"}); expect(screen.queryByRole("region")).toBeNull(); expect(document.activeElement).toBe(trigger);
});
it("supports touch opening, closes other character cards, and dismisses on outside pointer, scroll and resize", () => {
  mount(); mount({name: "Jinshi"}); fireEvent.click(screen.getByRole("button", {name: "Preview Maomao"})); fireEvent.click(screen.getByRole("button", {name: "Preview Jinshi"}));
  expect(screen.getAllByRole("region")).toHaveLength(1); expect(screen.getByRole("region", {name: "Profile of Jinshi"})).toBeTruthy();
  fireEvent.scroll(screen.getByRole("region")); expect(screen.getByRole("region")).toBeTruthy(); fireEvent.scroll(window); expect(screen.queryByRole("region")).toBeNull();
  fireEvent.click(screen.getByRole("button", {name: "Preview Jinshi"})); fireEvent.resize(window); expect(screen.queryByRole("region")).toBeNull();
  fireEvent.click(screen.getByRole("button", {name: "Preview Jinshi"})); fireEvent.pointerDown(document.body); expect(screen.queryByRole("region")).toBeNull();
});
it("fits a narrow display and handles absent biography without fabricating facts", () => {
  vi.spyOn(window, "innerWidth", "get").mockReturnValue(320); mount({name: "Maomao"}); fireEvent.click(screen.getByRole("button", {name: "Preview Maomao"}));
  expect(screen.getByRole("region").style.width).toBe("296px"); expect(screen.getByRole("region").style.left).toBe("12px"); expect(screen.getByText("No character biography available.")).toBeTruthy();
});
it("cancels delayed opening when leaving or unmounting", () => {
  const view = mount(); fireEvent.mouseEnter(anchor()); fireEvent.mouseLeave(anchor()); act(() => vi.advanceTimersByTime(500)); expect(screen.queryByRole("region")).toBeNull();
  fireEvent.mouseEnter(anchor()); view.unmount(); act(() => vi.advanceTimersByTime(500)); expect(screen.queryByRole("region")).toBeNull();
});

it.each(["\n", "\r\n", "<br>", "&lt;br&gt;"])("hides underscore metadata labels and their values with %s separators", separator => {
 const biography=["A member of the team.","__Height:__ 190 cm"," __Affiliation:__ Cleaners",'__Jinki:__ "Umbreaker"',"__A much longer metadata field:__ a private detail","Still part of the biography with __inline emphasis__."] .join(separator);
 mount({name:"Maomao",biography});
 fireEvent.click(screen.getByRole("button",{name:"Preview Maomao"}));
 const panel=screen.getByRole("region",{name:"Profile of Maomao"});
 expect(panel.textContent).toContain("A member of the team.");
 expect(panel.textContent).toContain("Still part of the biography with __inline emphasis__.");
 for(const hidden of ["Height","190 cm","Affiliation","Cleaners","Jinki","Umbreaker","private detail"])expect(panel.textContent).not.toContain(hidden);
});
it("shows the empty biography message when only underscore metadata remains",()=>{
 mount({name:"Maomao",biography:"__Height:__ 190 cm"});
 fireEvent.click(screen.getByRole("button",{name:"Preview Maomao"}));
 expect(screen.getByText("No character biography available.")).toBeTruthy();
});
