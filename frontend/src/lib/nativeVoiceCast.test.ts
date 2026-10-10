import {expect, it} from "vitest";
import {animeVoiceGroups, orderedCharacters} from "./nativeVoiceCast";
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

it("orders each language by characters, with narrator last and unmatched actors afterward", () => {
 const result = animeVoiceGroups({country_of_origin:"JP", characters:[{name:"Narrator"},{name:"First Lead"},{name:"Second"}], voice_cast:[
  {name:"Unknown",language:"Japanese",role:"Other"},
  {name:"Narration",language:"Japanese",role:"Narrator"},
  {name:"Second actor",language:"Japanese",role:"Second"},
  {name:"Lead actor",language:"Japanese",role:"Lead First · Second"},
  {name:"Dub second",language:"English",role:"Second"},
  {name:"Dub lead",language:"English",role:"First Lead"}
 ]},"en");
 expect(result.groups[0].cast.map(p=>p.name)).toEqual(["Lead actor","Second actor","Narration","Unknown"]);
 expect(result.groups[1].cast.map(p=>p.name)).toEqual(["Dub lead","Dub second"]);
});

it("places characters without portraits last and recognizes fallback portraits", () => {
 expect(orderedCharacters([{name:"Missing"},{name:"Narrator",image:"https://example.com/n.jpg"},{name:"Lead",image:"https://example.com/l.jpg"},{name:"Fallback"}], new Map([["fallback","https://example.com/f.jpg"]])).map(p=>p.name)).toEqual(["Lead","Fallback","Narrator","Missing"]);
});

it("keeps dub editions in one language row while preserving credit details",()=>{
 const result=animeVoiceGroups({country_of_origin:"JP",voice_cast:[{name:"Hilary",language:"English",role:"Satsuki"},{name:"Andrea",language:"English",role:"Satsuki",dub_group:"Animax"},{name:"Andrea",language:"English",role:"Datto",dub_group:"Animax",role_notes:"Young"}]},"en");
 expect(result.groups.map(g=>g.title)).toEqual(["Japanese Cast","English Cast"]);
 expect(result.groups[1].cast.map(p=>p.name)).toEqual(["Hilary","Andrea"]);
 expect(result.groups[1].cast).toHaveLength(2);
 expect(result.groups[1].cast[1].role).toBe("Satsuki · Datto");
 expect(result.groups[1].cast[1].role_notes).toBe("Young");
});

it("backfills edition labels from cached provider roles without guessing or overriding manual edits",()=>{
 const metadata={country_of_origin:"JP",voice_cast:[{name:"Andrea",provider_id:1,language:"English",role:"Satsuki"},{name:"Hilary",provider_id:2,language:"English",role:"Satsuki"}],anilist_data:{characters:{edges:[{node:{name:{full:"Satsuki"}},voiceActorRoles:[{dubGroup:"Animax",voiceActor:{id:1,name:{full:"Andrea"}}}]}]}}};
 expect(animeVoiceGroups(metadata,"en").groups[1].cast[0].dub_group).toBe("Animax");
 expect(animeVoiceGroups({...metadata,_sources:{voice_cast:"manual"}},"en").groups.map(g=>g.title)).toEqual(["Japanese Cast","English Cast"]);
});
