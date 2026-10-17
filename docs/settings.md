# Settings organization

Settings navigation is defined once in `frontend/src/features/settings/navigation.ts`.
Desktop navigation, mobile groups, page headers and search use this registry.
Existing `/settings/...` URLs and legacy `?tab=` links remain valid. Personal
Playback and Reading preferences remain available to regular users; server
administration stays restricted to administrators.

The shared page frame provides a header, scope badge, search and independently
scrolling content. Settings panels, rows, actions and scoped styles provide common
spacing, controls, focus states and surfaces. Appearance retains its optional live
split preview. Long pages use section links so navigating does not discard edits.

Configuration forms use explicit Save/Discard, preserve drafts through background
refetches, and protect drafts on page exit, sidebar links and the mobile settings
selector. Browser Back/Forward remains normal router behavior; save or discard
before using it. Provider credentials no longer save when focus leaves a field;
blank saved-secret fields preserve existing credentials. Tests use saved values.

Appearance, book display preferences, artwork feature toggles and browser username
preferences save immediately, with scope and automatic-save descriptions. Task
configuration retains per-task saving and cleanup review. Credential management
belongs to Metadata & artwork providers; library provider choices retain priority
and selection settings. Artwork has a dedicated settings page as well as its
plugin entry point. User create/edit and deletion use accessible focused dialogs.

Appearance color labels include General Accent plus independent Left Panel Accent,
Poster Hover Outline, Selection Accent, Keyboard Focus Accent and Link Accent.
Unset roles inherit General Accent. Use general accent removes a role override;
save the custom theme to persist it. Existing themes and older JSON using Accent
remain compatible. Media detail link colors retain their separate existing role.
