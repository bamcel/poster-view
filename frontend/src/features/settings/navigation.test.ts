import {expect,it} from "vitest";
import {searchSettings,visibleSettingsPages,settingsPath} from "./navigation";
it("keeps personal navigation separate and hides administration from regular users",()=>{
 expect(visibleSettingsPages(false).map(page=>page.id)).toEqual(["playback","reading"]);
 expect(visibleSettingsPages(true).map(page=>page.id)).toContain("artwork");
 expect(settingsPath("transcoding")).toBe("/settings/transcoding");
});
it("finds settings using feature words without exposing restricted pages",()=>{
 expect(searchSettings("gpu",true).map(page=>page.id)).toEqual(["transcoding"]);
 expect(searchSettings("api keys",true).map(page=>page.id)).toEqual(["sources"]);
 expect(searchSettings("gpu",false)).toEqual([]);
 expect(searchSettings("subtitle",false).map(page=>page.id)).toEqual(["playback"]);
});
