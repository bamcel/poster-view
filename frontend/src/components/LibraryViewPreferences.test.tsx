import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import LibraryViewPreferences, { useBackdropView, useYoutubeBannerBackground } from "./LibraryViewPreferences";
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

function BackgroundPreview({ library }: { library: string }) {
 const { enabled } = useYoutubeBannerBackground(library);
 return <output data-testid="background">{enabled ? "banner" : "backdrop"}</output>;
}

it("only offers page backgrounds for YouTube libraries and defaults to backdrop", () => {
 const { rerender } = render(<LibraryViewPreferences library="movies" />);
 expect(screen.queryByRole("combobox", { name: "Page background" })).toBeNull();
 rerender(<LibraryViewPreferences library="youtube" youtube />);
 expect((screen.getByRole("combobox", { name: "Page background" }) as HTMLSelectElement).value).toBe("backdrop");
 expect(screen.getByText(/wide cards keep using the backdrop/)).toBeTruthy();
});

it("persists the banner background independently of card display and other libraries", () => {
 const view = (library: string) => <><LibraryViewPreferences library={library} youtube /><BackgroundPreview library={library} /></>;
 const { rerender, unmount } = render(view("first"));
 fireEvent.change(screen.getByRole("combobox", { name: "Page background" }), { target: { value: "banner" } });
 expect(screen.getByTestId("background").textContent).toBe("banner");
 expect(localStorage.getItem("posterview.youtubeBackground.first")).toBe("banner");
 expect(localStorage.getItem("posterview.libraryView.first")).toBeNull();
 rerender(view("second"));
 expect(screen.getByTestId("background").textContent).toBe("backdrop");
 rerender(view("first"));
 expect(screen.getByTestId("background").textContent).toBe("banner");
 unmount();
 render(view("first"));
 expect(screen.getByTestId("background").textContent).toBe("banner");
 fireEvent.change(screen.getByRole("combobox", { name: "Page background" }), { target: { value: "backdrop" } });
 expect(screen.getByTestId("background").textContent).toBe("backdrop");
 expect(localStorage.getItem("posterview.youtubeBackground.first")).toBe("backdrop");
});

it("refreshes the active library preference after storage changes", () => {
 const { rerender } = render(<BackgroundPreview library="first" />);
 act(() => {
  localStorage.setItem("posterview.youtubeBackground.first", "banner");
  window.dispatchEvent(new StorageEvent("storage", { key: "posterview.youtubeBackground.first" }));
 });
 expect(screen.getByTestId("background").textContent).toBe("banner");
 rerender(<BackgroundPreview library="second" />);
 act(() => {
  localStorage.setItem("posterview.youtubeBackground.first", "backdrop");
  window.dispatchEvent(new StorageEvent("storage", { key: "posterview.youtubeBackground.first" }));
 });
 expect(screen.getByTestId("background").textContent).toBe("backdrop");
});


it("offers independent homepage channel switches only for YouTube libraries", () => {
 const { rerender } = render(<LibraryViewPreferences library="movies" />);
 expect(screen.queryByRole("switch")).toBeNull();
 rerender(<LibraryViewPreferences library="youtube" youtube />);
 const featured = screen.getByRole("switch", { name: "Show channels in the homepage banner" }) as HTMLInputElement;
 const background = screen.getByRole("switch", { name: "Use channel backdrops on the homepage" }) as HTMLInputElement;
 expect(featured.checked).toBe(false);
 expect(background.checked).toBe(false);
 fireEvent.click(featured);
 expect(featured.checked).toBe(true);
 expect(background.checked).toBe(false);
 fireEvent.click(background);
 expect(background.checked).toBe(true);
 rerender(<LibraryViewPreferences library="another-youtube" youtube />);
 expect((screen.getByRole("switch", { name: "Show channels in the homepage banner" }) as HTMLInputElement).checked).toBe(false);
 expect((screen.getByRole("switch", { name: "Use channel backdrops on the homepage" }) as HTMLInputElement).checked).toBe(false);
});
