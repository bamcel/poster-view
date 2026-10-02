import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import LibraryViewPreferences, { useBackdropView } from "./LibraryViewPreferences";
afterEach(() => { cleanup(); localStorage.clear(); });
function Preview({library}: {library:string}) { const {enabled}=useBackdropView(library); return <output>{enabled ? "Landscape" : "Portrait"}</output>; }
it("updates the selected library immediately and keeps other libraries independent", () => {
 const {rerender}=render(<><LibraryViewPreferences library="anime"/><Preview library="anime"/></>);
 expect(screen.getByRole("combobox",{name:"Display"}).getAttribute("aria-label")).toBe("Display");
 expect(screen.getByText("Portrait")).toBeTruthy();
 fireEvent.change(screen.getByRole("combobox"),{target:{value:"backdrop"}});
 expect(screen.getByText("Landscape")).toBeTruthy();
 rerender(<><LibraryViewPreferences library="movies"/><Preview library="movies"/></>);
 expect(screen.getByText("Portrait")).toBeTruthy();
 rerender(<><LibraryViewPreferences library="anime"/><Preview library="anime"/></>);
 expect(screen.getByText("Landscape")).toBeTruthy();
});
