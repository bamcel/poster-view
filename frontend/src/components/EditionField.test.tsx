import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import EditionField from "./EditionField";
afterEach(cleanup);
function Editor({ initial = "" }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return <><EditionField value={value} onChange={setValue} inputClass="" /><output data-testid="value">{value}</output></>;
}
it("offers presets and custom input without replacing existing editions", () => {
  render(<Editor initial="Collector's Edition" />);
  expect((screen.getByLabelText("Custom Edition") as HTMLInputElement).value).toBe("Collector's Edition");
  fireEvent.change(screen.getByLabelText("Edition"), { target: { value: "Colored" } });
  expect(screen.getByTestId("value").textContent).toBe("Colored");
  expect(screen.queryByLabelText("Custom Edition")).toBeNull();
  fireEvent.change(screen.getByLabelText("Edition"), { target: { value: "custom" } });
  fireEvent.change(screen.getByLabelText("Custom Edition"), { target: { value: "Deluxe" } });
  expect(screen.getByTestId("value").textContent).toBe("Deluxe");
});
it("does not silently populate empty editions", () => {
  render(<Editor />);
  expect((screen.getByLabelText("Edition") as HTMLSelectElement).value).toBe("");
  expect(screen.getByTestId("value").textContent).toBe("");
});
