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

- [x] fixed

## What changed

`static/css/style.css` only — no handler or markup restructuring was needed:

- `html, body { height: 100% }` and `body` becomes a flex column with
  `overflow: hidden`; `#topnav` and `#footer` are `flex: 0 0 auto`, so they stay
  put.
- `#content` is `flex: 1 1 auto; min-height: 0; overflow: auto` — the only
  scrolling part of the page. `min-height: 0` is what lets it shrink instead of
  overflowing the column, and it also gives wide result tables their own
  horizontal scrollbar.
- `.breadcrumbs` is part of the fixed header now (`flex: 0 0 auto`, padding
  instead of `margin-left`).
- The footer loses its `margin-top: 6em` (it was there to push the footer down a
  long page; with a fixed footer it just wasted space) and `clear: both`.

One knock-on fix: `views/row_detail_wrapper.pug` positioned the view switcher
with `style='float:right'`, but that element is a direct child of `body`, i.e. a
flex item, and `float` does not apply to flex items. It now uses a `.nav2` class
with `text-align: right`.

## Verification

- The suite passes; the row-view link test exercises `row_detail_wrapper.pug`,
  so a template error there would fail it.
- The served `/_/css/style.css` contains the new rules, and the row-detail page
  renders `<p class="nav2">` with the switcher links.

Caveat: this is a layout change and I verified it structurally (rules served,
markup compatible, templates render) rather than visually — there is no browser
available here. Worth a quick look in a real browser, especially a long table
listing and a row-detail page with the floating SQL form.

    $ node test/run.js
    7 / 21 / 18 / 62 passed, 0 failed
