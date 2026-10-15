import {describe,expect,it} from "vitest";
import {subtitleDelay,subtitleOffset} from "./subtitleTiming";
describe("subtitle timing",()=>{
  it("combines positive and negative delay with absolute segmented timestamps",()=>{
    expect(subtitleOffset(290,2)).toBe(288);
    expect(subtitleOffset(290,-2)).toBe(292);
    expect(subtitleOffset(0,2)).toBe(-2);
  });
  it("defaults old state and bounds invalid input",()=>{
    expect(subtitleDelay(undefined)).toBe(0);expect(subtitleDelay(NaN)).toBe(0);
    expect(subtitleDelay(100)).toBe(60);expect(subtitleDelay(-100)).toBe(-60);
  });
});
