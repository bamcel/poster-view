import type { PlaybackPreferences } from "../types";

type Appearance = Required<Pick<PlaybackPreferences,"subtitle_color"|"subtitle_shadow"|"subtitle_background"|"subtitle_position">>;
export function subtitleAppearance(preferences: PlaybackPreferences): Appearance {
  return {
    subtitle_color: /^#[\da-f]{6}$/i.test(preferences.subtitle_color??"")?preferences.subtitle_color!:"#ffffff",
    subtitle_shadow: preferences.subtitle_shadow==="drop"||preferences.subtitle_shadow==="outline"?preferences.subtitle_shadow:"none",
    subtitle_background: preferences.subtitle_background==="none"||preferences.subtitle_background==="light"?preferences.subtitle_background:"dark",
    subtitle_position: preferences.subtitle_position==="top"||preferences.subtitle_position==="bottom"?preferences.subtitle_position:"auto",
  };
}

export function subtitleAppearanceVariables(preferences: PlaybackPreferences) {
  const appearance=subtitleAppearance(preferences);
  return {
    "--subtitle-color": appearance.subtitle_color,
    "--subtitle-background": appearance.subtitle_background==="none"?"transparent":appearance.subtitle_background==="light"?"rgba(255,255,255,.75)":"rgba(0,0,0,.65)",
    "--subtitle-shadow": appearance.subtitle_shadow==="drop"?"1px 2px 3px rgba(0,0,0,.95)":appearance.subtitle_shadow==="outline"?"-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000":"none",
  };
}

/** Called only for plain-text WebVTT cues, after source timestamps are shifted. */
export function applyPlainSubtitlePosition(cue: TextTrackCue, position: Appearance["subtitle_position"]) {
  if(position==="auto"||!("line" in cue)||!("snapToLines" in cue))return;
  const plain=cue as VTTCue;
  plain.snapToLines=true;
  plain.line=position==="top"?0:-1;
}
