import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import PosterCard from "./PosterCard";

afterEach(cleanup);
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
