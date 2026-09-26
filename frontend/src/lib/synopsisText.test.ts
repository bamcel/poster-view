import { expect, it } from "vitest";
import { synopsisText } from "./synopsisText";

it("preserves description breaks and entities without exposing markup or scripts", () => {
  expect(synopsisText('First &amp; second<br /><br>Next <b>paragraph</b><script>alert(1)</script>')).toBe("First & second\n\nNext paragraph");
  expect(synopsisText(null)).toBe("");
});
