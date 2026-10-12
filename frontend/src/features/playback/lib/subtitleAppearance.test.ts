import {describe,expect,it} from "vitest";
import {defaultPlaybackPreferences} from "../types";
import {applyPlainSubtitlePosition,subtitleAppearance,subtitleAppearanceVariables} from "./subtitleAppearance";
describe("plain-text subtitle appearance",()=>{
 it("supplies unchanged defaults when older saved preferences omit appearance fields",()=>{
  const legacy={...defaultPlaybackPreferences,subtitle_color:undefined,subtitle_shadow:undefined,subtitle_background:undefined,subtitle_position:undefined};
  expect(subtitleAppearance(legacy)).toEqual({subtitle_color:"#ffffff",subtitle_shadow:"none",subtitle_background:"dark",subtitle_position:"auto"});
  expect(subtitleAppearanceVariables(legacy)).toEqual({"--subtitle-color":"#ffffff","--subtitle-shadow":"none","--subtitle-background":"rgba(0,0,0,.65)"});
 });
 it("uses only supported colors and static style mappings",()=>{
  expect(subtitleAppearanceVariables({...defaultPlaybackPreferences,subtitle_color:"#ffee00",subtitle_background:"none",subtitle_shadow:"outline"})).toEqual({"--subtitle-color":"#ffee00","--subtitle-background":"transparent","--subtitle-shadow":"-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000"});
  expect(subtitleAppearanceVariables({...defaultPlaybackPreferences,subtitle_color:"url(https://example.test)"})["--subtitle-color"]).toBe("#ffffff");
 });
 it("preserves author cue placement in automatic mode",()=>{
  const cue={line:35,snapToLines:false,position:25,align:"end",startTime:12,endTime:20} as VTTCue;
  applyPlainSubtitlePosition(cue,"auto");expect(cue).toEqual({line:35,snapToLines:false,position:25,align:"end",startTime:12,endTime:20});
 });
 it("moves cues to explicit top or bottom without changing timing, horizontal position, or alignment",()=>{
  const cue={line:35,snapToLines:false,position:25,align:"end",startTime:12,endTime:20} as VTTCue;
  applyPlainSubtitlePosition(cue,"top");expect(cue.line).toBe(0);expect(cue.snapToLines).toBe(true);
  applyPlainSubtitlePosition(cue,"bottom");expect(cue.line).toBe(-1);expect(cue.startTime).toBe(12);expect(cue.endTime).toBe(20);expect(cue.position).toBe(25);expect(cue.align).toBe("end");
 });
});
