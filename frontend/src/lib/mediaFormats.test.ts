import { describe, expect, it } from "vitest";
import type { NativeCatalogEntry } from "../api/nativeLibraries";
import { mediaFormats } from "./mediaFormats";

function entry(...versions: Record<string, unknown>[][]): NativeCatalogEntry {
  return {
    id: "movie", path: "/movie", kind: "movie", parent_path: null, title: "4K Atmos",
    metadata: {}, artwork: [], nfo_path: null, available: true, revision: 1,
    files: versions.map(streams => ({ path: "/movie.4k.atmos.mkv", size: 1, extension: "mkv", media_info: { streams } })),
  };
}
const video = (width: unknown, height: unknown, extra: Record<string, unknown> = {}) => ({ codec_type: "video", width, height, ...extra });
const audio = (channels: unknown, extra: Record<string, unknown> = {}) => ({ codec_type: "audio", channels, ...extra });

describe("mediaFormats", () => {
  it("shows BD for file versions and inherited episode sources",()=>{
    const item=entry([video(1920,1080)]);
    item.metadata.media_sources={[item.files[0].path]:"bd"};
    expect(mediaFormats(item)).toEqual({source:"BD",quality:"Full HD"});
    item.kind="episode";item.metadata._inherited_media_source="bd";
    expect(mediaFormats(item)).toEqual({source:"BD",quality:"Full HD"});
  });
  it("shows Mixed as an inherited series source",()=>{
    const item=entry([video(1920,1080)]);item.kind="episode";item.metadata._inherited_media_source="mixed";
    expect(mediaFormats(item)).toEqual({source:"Mixed",quality:"Full HD"});
  });
  it("uses the inherited series or season source for episodes instead of file-version overrides",()=>{
    const item=entry([video(1920,1080)]);item.kind="episode";
    item.metadata.media_sources={[item.files[0].path]:"bluray"};
    item.metadata._inherited_media_source="web-dl";
    expect(mediaFormats(item)).toEqual({source:"WEB-DL",quality:"Full HD"});
    delete item.metadata._inherited_media_source;
    expect(mediaFormats(item)).toEqual({quality:"Full HD"});
  });
  it("uses only the selected highest-resolution version's confirmed source",()=>{
    const item=entry([video(1920,1080)],[video(3840,2160)]);
    item.files[0].path="Film - Original.mkv";item.files[1].path="Film - UHD.mkv";
    item.metadata.media_sources={"Film - Original.mkv":"bluray","Film - UHD.mkv":"web-dl"};
    expect(mediaFormats(item)).toEqual({source:"WEB-DL",quality:"UHD 4K"});
    item.metadata.media_sources={"Film - Original.mkv":"bluray","Film - UHD.mkv":""};
    expect(mediaFormats(item)).toEqual({quality:"UHD 4K"});
    item.metadata.media_sources={"Film - UHD.mkv":"made-up"};
    expect(mediaFormats(item)).toEqual({quality:"UHD 4K"});
  });
  it("uses the preferred language's channels instead of the strongest other-language track",()=>{
    const item=entry([audio(6,{tags:{language:"jpn"},disposition:{default:1}}),audio(2,{tags:{language:"eng"}})]);
    expect(mediaFormats(item,{audio_languages:["en"],prefer_default_audio:false})).toEqual({audio:"Stereo",dualAudio:true});
    expect(mediaFormats(item,{audio_languages:["ja"],prefer_default_audio:false})).toEqual({audio:"5.1 Surround",dualAudio:true});
    expect(mediaFormats(item,{audio_languages:["en"],prefer_default_audio:true})).toEqual({audio:"5.1 Surround",dualAudio:true});
    expect(mediaFormats(item,{audio_languages:["fr"],prefer_default_audio:false})).toEqual({audio:"5.1 Surround",dualAudio:true});
  });
  it("labels multiple distinct audio languages as Dual Audio",()=>{
    expect(mediaFormats(entry([audio(2,{tags:{language:"eng"}}),audio(2,{tags:{language:"jpn"}})])))
      .toEqual({audio:"Stereo",dualAudio:true});
  });
  it("does not count duplicate language codes, regions, unknown tracks or subtitles",()=>{
    expect(mediaFormats(entry([audio(2,{tags:{language:"eng"}}),audio(6,{tags:{language:" en-US "}}),audio(2,{tags:{language:"und"}}),audio(2,{tags:{language:"mul"}}),audio(2),{codec_type:"subtitle",tags:{language:"jpn"}}])))
      .toEqual({audio:"5.1 Surround"});
  });
  it("does not combine audio languages from separate versions",()=>{
    expect(mediaFormats(entry([video(1920,1080),audio(2,{tags:{language:"eng"}})],[video(1280,720),audio(2,{tags:{language:"jpn"}})])))
      .toEqual({quality:"Full HD",audio:"Stereo"});
  });
  it.each([
    [720, 480, "SD"], [1280, 720, "HD"], [1920, 800, "Full HD"],
    [3840, 1600, "UHD 4K"], [7680, 3200, "8K"], [1080, 1920, "Full HD"],
  ])("labels %s by %s resolution as %s", (width, height, quality) => {
    expect(mediaFormats(entry([video(width, height)]))).toEqual({ quality });
  });

  it("does not infer badges from names or incomplete dimensions", () => {
    expect(mediaFormats(entry([]))).toEqual({});
    expect(mediaFormats(entry([video(3840, null)]))).toEqual({});
    expect(mediaFormats(entry([video("invalid", Infinity)]))).toEqual({});
  });

  it("handles numeric strings and ignores attached cover images", () => {
    expect(mediaFormats(entry([
      video(8000, 8000, { disposition: { attached_pic: 1 } }), video("1920", "1080"),
    ]))).toEqual({ quality: "Full HD" });
  });

  it.each([
    [{ side_data_list: [{ side_data_type: "DOVI configuration record", dv_profile: 8 }] }, "Dolby Vision"],
    [{ color_transfer: "smpte2084", color_primaries: "bt2020" }, "HDR10"],
    [{ color_transfer: "arib-std-b67" }, "HLG"],
  ])("detects confirmed HDR metadata", (attributes, hdr) => {
    expect(mediaFormats(entry([video(3840, 2160, attributes)]))).toEqual({ quality: "UHD 4K", hdr });
  });

  it("does not treat ten-bit or BT2020 alone as HDR", () => {
    expect(mediaFormats(entry([video(1920, 1080, { pix_fmt: "yuv420p10le", color_primaries: "bt2020" })])))
      .toEqual({ quality: "Full HD" });
  });

  it.each([[2, "Stereo"], [6, "5.1 Surround"], [8, "7.1 Surround"]])("labels %s channels without inventing spatial audio", (channels, label) => {
    expect(mediaFormats(entry([audio(channels)]))).toEqual({ audio: label });
  });

  it("requires explicit Atmos or DTS:X markers", () => {
    expect(mediaFormats(entry([audio(8, { codec_name: "truehd" })]))).toEqual({ audio: "7.1 Surround" });
    expect(mediaFormats(entry([audio(8, { profile: "TrueHD + Atmos" })]))).toEqual({ audio: "Dolby Atmos" });
    expect(mediaFormats(entry([audio(6, { profile: "E-AC-3 JOC" })]))).toEqual({ audio: "Dolby Atmos" });
    expect(mediaFormats(entry([audio(8, { profile: "DTS-HD MA + DTS:X" })]))).toEqual({ audio: "DTS:X" });
  });

  it("chooses the best audio in the highest resolution version only", () => {
    expect(mediaFormats(entry(
      [video(1920, 1080), audio(8, { profile: "Atmos" })],
      [video(3840, 1600), audio(2), audio(6)],
    ))).toEqual({ quality: "UHD 4K", audio: "5.1 Surround" });
  });

  it("supports channel layouts when channel counts are missing", () => {
    expect(mediaFormats(entry([audio(null, { channel_layout: "5.1(side)" })]))).toEqual({ audio: "5.1 Surround" });
  });
});
