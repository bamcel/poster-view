# Mobile layout handoff

Use this file as an implementation brief for making another application mobile friendly. It draws on PosterView's responsive shell, settings, library grid, and accessibility patterns. Adapt the navigation labels and data entities to the receiving application; do not copy its backend or theme wholesale.

## Implementation brief

Keep every existing workflow usable at 320 CSS pixels wide. Start with a single-column layout, then add columns when the available content width supports them. Preserve the application's visual identity, data behavior, and desktop workflows. Finish mobile layout and interaction checks before additional desktop styling.

Inspect the receiving application's existing components, styles, routes, and tests first. Reuse its framework and design tokens. Implement the rules below in shared primitives where possible rather than applying disconnected fixes to individual pages.

## Responsive dimensions

| Property | Starting rule |
| --- | --- |
| Minimum supported viewport | 320 CSS pixels |
| Page side padding | 16px mobile; 24px from 640px; 32px from 1024px |
| Card padding | 12–16px |
| Control target | At least 44px high **and** 44px wide for icon buttons |
| Control spacing | 8–12px between adjacent actions |
| Primary body/input text | Prefer 16px on phones; retain browser zoom |
| Layout breakpoints | 640px, 768px, 1024px, 1280px as starting points |
| Main content | `min-width: 0`; flex/grid children must be allowed to shrink |

These breakpoints match the usual Tailwind defaults used by PosterView. Change them if the receiving application's content needs more space. Account for sidebar width: a 768px viewport does not necessarily leave enough room for a two-column content panel.

## Application shell and navigation

- Below 768px, replace the desktop sidebar with a compact horizontal header. PosterView uses a 56px header and 44px navigation targets with accessible names for icon links.
- Keep the active workspace/account/server selector on its own row below navigation. A long selected name must not squeeze navigation buttons out of view.
- At wider widths, restore the sidebar and full navigation labels. PosterView's desktop sidebar is approximately 236px wide.
- If the receiving app has too many navigation destinations for a 320px header, use a labeled menu or an appropriate bottom navigation instead of shrinking targets.
- Preserve route state, active navigation indication, sign-out access, and workspace selection at every size.
- Respect device safe areas around fixed headers, footers, and bottom actions.

## Page headers, filters, and tabs

Stack page title, secondary controls, filter input, and tabs vertically on phones. A desktop title/action row should become multiple rows rather than clipped text or squeezed controls. Use full-width mobile search inputs.

Allow horizontal scrolling **inside** a tab strip when its labels cannot fit. Keep the overall page within the viewport. Keep selected tabs reachable and focusable; use proper selected state. Long tab labels can truncate if the full label remains available accessibly, but important headings and form labels should wrap.

## Settings and forms

- Use one column by default, two only when controls fit comfortably, and additional columns only in generous content widths.
- Put related controls in one card with a clear heading. Avoid unnecessary nested borders and containers.
- Place an optional selector above the related options. PosterView's Show Providers card places Default provider on the left above the Poster options.
- Wrap action rows and right-align them where appropriate. On a very narrow phone, allow full-width stacked buttons if the labels cannot fit safely.
- Keep checkbox/switch labels clickable, wrapping, and at least 44px high. A small visual switch can sit inside a larger button target.
- Label every input and switch. Placeholder text alone is not a label.
- Put connection-test results and validation errors next to the relevant controls. Temporary notifications may supplement persistent feedback.
- Show destructive confirmation details: the affected entity, what data is removed, and what is retained. Preserve long names and identifiers in readable text.
- Let JSON/code editors scroll internally without widening the page. Use readable type and adequate line spacing; do not resize the entire interface to fit code.

## Cards, grids, and long content

PosterView uses an automatic grid with a 125px minimum tile width on phones and 150px from 640px, with 16px and 20px gaps respectively. This fits two poster tiles at 320px with 16px page padding. For another application's cards, choose a minimum based on actual content rather than blindly copying these values.

```css
.card-grid {
  display: grid;
  gap: 16px;
  grid-template-columns: repeat(auto-fill, minmax(125px, 1fr));
}
@media (min-width: 640px) {
  .card-grid {
    gap: 20px;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  }
}
```

Use `min-width: 0` on flex/grid text regions. Apply `overflow-wrap: anywhere` to long names, URLs, and identifiers where breaking is appropriate. Keep adjacent icons and buttons from shrinking. Truncate only secondary text or compact list titles; provide the full value in an accessible detail view, not only a hover tooltip.

Keep image aspect ratios stable and provide missing-image placeholders. Avoid permanently covering content with action overlays. PosterView removed its three-dot poster overlay; another app should still provide a discoverable touch action if its workflow requires a context menu.

## Menus, dialogs, and touch

- Important actions must work without hover, right-click, or a physical keyboard. Use a visible labeled action, an item detail screen, or another discoverable touch entry point. Do not treat long-press alone as a complete touch solution.
- Anchor menus within the viewport. Bound their width and height, allow internal scrolling, and reposition them near screen edges.
- Keyboard menus should focus the first enabled action, support Arrow Up/Down and Home/End, close with Escape, and return focus to the trigger. Tab should dismiss the menu and continue through the page.
- Close menus on outside interaction without swallowing unrelated actions. Do not close a touch menu merely because a pointer leaves a card.
- Dialogs need a visible title, close action, appropriate focus management, and content that remains reachable with the on-screen keyboard open.
- Bottom sheets can work well on phones; keep desktop dialogs if appropriate. Neither should exceed the usable viewport height.

## Shared CSS starting point

Adapt these selectors to the receiving app's component system. Do not hide horizontal overflow to conceal layout bugs.

```css
:root { --focus-color: #bd93f9; }
* { box-sizing: border-box; }
.content, .text-region { min-width: 0; }
.long-value { overflow-wrap: anywhere; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }

:where(button, a, input, select, textarea, summary, [tabindex]):focus-visible {
  outline: 2px solid var(--focus-color);
  outline-offset: 3px;
}
@media (max-width: 767px), (pointer: coarse) {
  button, select, .navigation-link { min-height: 44px; }
  .icon-button { min-width: 44px; }
  input:not([type="checkbox"]):not([type="radio"]):not([type="color"]) {
    min-height: 44px;
    font-size: 16px;
  }
  .checkbox-label { min-height: 44px; }
}
```

Include a normal viewport meta tag with `width=device-width, initial-scale=1`. Keep zoom enabled. Prefer dynamic viewport units such as `dvh` when a full-height shell must respond to mobile browser chrome; test a fallback as appropriate. Avoid overlapping fixed-height panels and nested scroll regions that trap content.

## Status and accessibility

Show readable loading, stopping, success, failure, and empty states in the affected component. Use polite live announcements for meaningful asynchronous changes without announcing every poll. Progress should have an accessible name. Preserve last-success information separately from failed or cancelled attempts.

Keep visible keyboard focus across the app. Use native buttons, inputs, and selects whenever possible, accessible names for icon controls, and switch/checkbox state that assistive technology can read. Do not rely on color alone for state. Check contrast against the actual theme, and respect reduced-motion preferences.

## Verification and acceptance

Test at 320, 375, 390, 768, and 1280px, plus phone landscape. The 320/375px PosterView checks informed these patterns; this document is not a claim that the receiving app has already passed them.

- [ ] No page-level horizontal scrolling, clipped actions, or overlapping controls.
- [ ] Long names with spaces, long unbroken strings, and URLs remain usable.
- [ ] Navigation and workspace selection work without shrinking touch targets.
- [ ] Forms, switches, checkbox labels, and destructive confirmations work by touch.
- [ ] All important actions have a touch entry point; no essential hover-only control.
- [ ] Menus opened at the right and bottom edges stay within the viewport.
- [ ] On-screen keyboard does not hide the active input or essential dialog actions.
- [ ] Keyboard focus, Tab order, Enter/Space, Escape, and menu arrow navigation work.
- [ ] Zoom and larger text do not obscure essential content or controls.
- [ ] Loading, error, retry, empty, and success states fit narrow cards.
- [ ] Desktop navigation, forms, grids, and existing workflows still work.
- [ ] Relevant behavior tests and the production build pass.

Capture screenshots of representative screens at phone and desktop widths. Fix actual overflow and interaction defects before adding more desktop styling. Report what was checked and any remaining limitations.

## PosterView reference files

Repository-relative references for the implementing developer:

- `frontend/src/components/Layout.tsx`: responsive navigation and separate mobile server selector.
- `frontend/src/pages/LibraryPage.tsx`: stacked header, filters, tab strip, automatic tile grid.
- `frontend/src/pages/SettingsPage.tsx`: responsive settings cards, provider options, inline feedback, cache actions.
- `frontend/src/components/ui.tsx`: labeled switch with a larger target.
- `frontend/src/lib/actionMenu.ts`: keyboard menu navigation and focus restoration.
- `frontend/src/components/CustomTargetButton.tsx`: viewport-bounded popup positioning.
- `frontend/src/index.css`: shared focus indicators, touch target rules, reduced-motion behavior.

Use these as patterns, not a requirement to introduce React or Tailwind into a different stack.
