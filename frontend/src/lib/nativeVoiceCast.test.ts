import {expect, it} from "vitest";
import {animeVoiceGroups} from "./nativeVoiceCast";
it("uses explicit original language before country and changes preferred cast from stored data", () => {
 const metadata = {country_of_origin:"JP",tmdb_data:{original_language:"ko"},voice_cast:[{name:"Original",language:"Korean"},{name:"Dub",language:"English"}]};
 expect(animeVoiceGroups(metadata,"en").groups[0].title).toBe("Korean Cast");
 expect(animeVoiceGroups(metadata,"ko").groups).toHaveLength(1);
});
it.each([["JP","Japanese"],["KR","Korean"]])("groups %s originals before English dub cast", (country,original) => {
 const result = animeVoiceGroups({country_of_origin:country,voice_cast:[{name:"Original",language:original,role:"Lead"},{name:"Dub",language:"English",role:"Lead"}]},"en-US");
 expect(result.groups.map(g=>g.title)).toEqual([`${original} Cast`,"English Cast"]);
 expect(result.groups[0].cast[0].name).toBe("Original"); expect(result.groups[1].cast[0].name).toBe("Dub");
});
it("does not duplicate matching languages and combines multiple character roles", () => {
 const result = animeVoiceGroups({country_of_origin:"JP",voice_cast:[{name:"Actor",provider_id:1,language:"Japanese",role:"Lead"},{name:"Actor",provider_id:1,language:"Japanese",role:"Second"}]},"ja");
 expect(result.groups).toHaveLength(1); expect(result.groups[0].cast).toHaveLength(1); expect(result.groups[0].cast[0].role).toBe("Lead · Second");
});
it("shows a missing-dub state without presenting another language as preferred", () => {
 const result = animeVoiceGroups({country_of_origin:"KR",voice_cast:[{name:"Actor",language:"Korean"}]},"en");
 expect(result.groups[1].cast).toHaveLength(0); expect(result.groups[1].empty).toContain("No English voice cast");
});
