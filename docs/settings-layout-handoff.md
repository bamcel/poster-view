# PosterView Settings — Visual Layout Handoff

> Developer reference: this describes the current visual structure for implementation work. For
> user instructions, see [Getting started](user-guide.md).

Use this specification to make another app match PosterView's settings. Preserve that app's functionality and labels; reproduce the layout hierarchy, tokens, spacing, and interaction patterns below.

## Layout blueprint

```text
Centered settings workspace (maximum 72rem)
├── Settings title
├── Horizontally scrolling tabs                 Save status
│   └── Thin bottom rule
└── Active page — rounded outer card
    ├── Icon + page heading
    ├── Short description
    └── Content groups — rounded secondary cards
        ├── Group heading + description           Header action
        └── Optional inset content card
            ├── Saved item heading               Icon actions
            └── Borderless disclosure
                ├── Label + “X of Y shown”        Chevron
                └── Checkbox options (when expanded)
```

Avoid a full-width, stretched dashboard or permanent vertical sidebar inside settings. Use compact cards and progressive disclosure rather than exposing every form at once.

## Sizing and spacing

All rem values below are authoritative. Pixel equivalents assume a 16px root font. PosterView actually uses `html { font-size: clamp(12px, 1.1vw, 16px) }`, so rem-based dimensions shrink on smaller screens. The maximum 72rem workspace is 1152px at a 16px root, or 864px at a 12px root. Borders remain 1px.

| Element | Specification |
| --- | --- |
| Workspace | Full available width, centered, max-width 72rem |
| Page gutters | 1rem mobile; 1.5rem from 640px; 2rem from 1024px |
| Page vertical padding | 1rem |
| Title / tabs / active card gap | 1rem |
| Outer page card | 1px border, 1rem radius, 1rem padding |
| Secondary group card | 1px border, .75rem radius, .75rem padding; cache panels use 1rem padding |
| Inset saved-item / database card | 1px border, .75rem radius, .75rem padding |
| Separate groups / cards | .75rem gap |
| Field grids | .75rem gap; bottom-align fields when labels wrap |
| Checkbox option grids | .5rem gap |
| Controls / tabs | .5rem radius |
| Standard input | .75rem horizontal padding, .5rem vertical padding |
| Compact input | .75rem horizontal padding, .375rem vertical padding |
| Icon-only action | 2.25rem square, .5rem radius |
| Disclosure summary | .75rem horizontal padding, .5rem vertical padding |
| Disclosure contents | .75rem padding, .25rem top padding |

At 1280px and above, the settings workspace fills its available height; the active page card scrolls internally. Below that breakpoint, allow the settings page to scroll naturally. Do not hard-code a fixed card height or clip expanded option lists.

## Typography and icons

- Font: system sans-serif (`ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif`).
- Settings title: 1.5rem, weight 600.
- Active-page heading: 1.125rem, weight 600; icon 1.25rem in accent color.
- Group headings and primary controls: .875rem; headings weight 600.
- Field labels, helper text, count summaries, save status: .75rem.
- Icons: Lucide outline style; typically 1rem, with .5rem between icon and text.
- JSON Editor: monospace, .5625rem font, .75rem line-height.

## Theme tokens — semantic reference

Use semantic variables rather than scattering hex values through components.

| Role | Color |
| --- | --- |
| Page background | #15171C |
| Outer card / inset card (`surface`) | #20232A |
| Secondary group card (`surface-2`) | #252932 |
| Sidebar / theme-menu backdrop | #1B1E25 |
| Input | #1D2028 |
| Input hover | #292E38 |
| Button | #3B4252 |
| Button hover / selected surface | #2E3440 |
| Border | #3B4252 |
| Strong border | #4C566A |
| Primary text | #ECEFF4 |
| Label text (`muted`) | #D8DEE9 |
| Helper text (`faint`) | #A7B0C0 |
| Disabled text | #7D8797 |
| Accent / progress / selected tab border | #BD93F9 |
| Success | #50FA7B |
| Warning | #EBCB8B |

Use thin borders and subtle background changes, not large shadows. The floating theme menu is the exception: it uses a shadow and a border.

## Tabs and save status

- One non-wrapping horizontal row on every screen size. Scroll horizontally on mobile; never stack tabs.
- Tab gap: .75rem. Tab padding: 1rem horizontally, .5rem vertically.
- Selected tab: accent 1px border, secondary-card background, primary text.
- Inactive tab: transparent border, muted text; primary text on hover.
- Tab strip: 1px bottom border and .75rem bottom padding. The scrollable tab row also has .75rem bottom padding to keep its scrollbar off the selected tab outline.
- Save status sits to the right on wider screens; below the tabs, right-aligned, on mobile.
- Preserve the active tab in the URL (`?tab=...`) with a session fallback, so leaving and
  returning to Settings or refreshing does not reset the page.
- Autosave status: “Saving settings…”, “Settings saved automatically.”, or an error message. Do not introduce an unnecessary Save Settings button.

## Per-page composition

### Server

One full-width outer card containing the media-server group:

1. **Media Servers**: heading and connection description on the left; **Add server** on the right. When the add/edit form is open, **Cancel** occupies the same header-action position. Saved servers each have their own inset card, with edit/delete icon buttons at the right. **Show Libraries** is a borderless disclosure with a count summary beneath the label. Its text aligns with the server name. The form is collapsed by default; its fields become two columns from 640px.

### Search Providers

One outer card with heading, description, and saved-secret guidance. Four compact provider cards use one column below 1024px and two columns above it. Each contains a heading, labeled credential fields, and **Test Connection**. Keep all test buttons visually identical. Bottom-align adjacent inputs when labels have different line counts. A full-width **Provider defaults** card follows the provider grid.

### Database

One outer card with one **ServerName Cache** group card per saved server. Cache and Watchdog form a single visual entity:

- Header and concise shared description.
- Usage strip: used storage on the left, cached-item count on the right, progress bar beneath.
- Aligned control grid: maximum storage, retention, automatic preloading (switch plus interval). One column on mobile, two from 640px, three from 1024px.
- One short Watchdog explanation; no separate Watchdog card or divider.
- One wrapping action row: Run Watchdog now, Cancel while running, Clear cache.
- Run message, progress bar, and processed-title count beneath actions.

### Appearance

Use the same full workspace width as Server. **Dashboard** and **Theme** each have their own
full-width outer card and heading. The Dashboard card contains the backdrop switch, Panel Color,
Panel Blur, Panel Overlay, Backdrop Overlay, and reset action. The Theme card contains theme
selection, individual-color editing, and custom-theme controls. **JSON Editor** is a collapsible
section inside Custom theme rather than a permanent split column. Theme menus use small palette
swatches beside names and the sidebar color for their backdrop. Everforest is the default theme.

### Privacy / Security

One outer card with heading and short explanation, followed by one secondary card containing vertically stacked option paragraphs. Use subtle horizontal dividers between options, not side-by-side mini-cards. Keep labels and descriptions compact. A security warning may have its own small amber inset and dismiss control.

## Interaction and accessibility requirements

- Disclosure rows use native `details` / `summary`, keyboard support, and a chevron rotated 180 degrees when open. No border outline or separator inside these disclosures.
- Switches use `role="switch"`, an accessible name, and `aria-checked`; nominal size 2.75rem by 1.5rem.
- All inputs have associated labels; icon-only actions have accessible names.
- Focus border uses the accent token; disabled controls retain readable text and roughly 50% opacity where appropriate.
- Keep secret values masked. Empty saved-secret fields preserve existing values.
- Keep actions in a consistent place when UI state changes; do not move Cancel to the form footer.

## Implementation acceptance checklist

- All settings tabs share one centered width, outer-card style, and spacing rhythm.
- No horizontal overflow except intentional tab strips and floating menus.
- Expanded disclosures show every option without clipping.
- Input baselines match even when labels wrap.
- Mobile retains single-row scrolling tabs and stacked content grids.
- Desktop fills available height without stretched fields spanning the entire monitor.
- Actual application functionality and autosave behavior remain unchanged.

## Source references

- `frontend/src/pages/SettingsPage.tsx`: workspace, tabs, cards, provider grid, cache controls, theme controls, disclosures.
- `frontend/src/components/SecuritySection.tsx`: stacked security options and warning styling.
- `frontend/src/lib/theme.ts`: built-in palettes, Everforest default, and semantic theme mapping.
- `frontend/src/index.css`: responsive root font, global typography, and scrollbars.
