# 11 — The top and bottom of the page should be fixed

**Severity:** low (polish — README "To do")
**Area:** `views/page.pug`, `static/css/style.css`
**Source:** README, "fix page layout — the top and the bottom should be fixed,
non-scrollable"

## Current state

`views/page.pug` lays out `#topnav`, `p.breadcrumbs`, `#content` and `#footer` in
normal flow, so the header (with the logout link) and the footer (reset/restart)
scroll away on long pages — row listings and table details are long. The legacy
`view/parent.html` has the same structure.

## Fix

- Make the page a full-height column: `#topnav` fixed at the top, `#footer`
  fixed at the bottom, `#content` scrolling in between (`position: fixed` plus
  padding, or a flex column with `height: 100vh` and `overflow: auto` on the
  content and breadcrumbs).
- Keep the current markup so no handler changes are needed; apply it in
  `static/css/style.css`, shared by both engines until issue 09 removes the
  legacy one.
- Check the row-detail pages and the SQL form, which have their own floated
  sidebars, at both narrow and wide widths.

## Verification

- With a long table, the header and footer stay visible while the content
  scrolls; no content is hidden behind the fixed bars.

## Status

- [ ] fixed
