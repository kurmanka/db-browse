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

## Corrigendum: the first attempt put the scrollbars inside the page

The flex-column version above made `#content` the scroll container, inset by its
`margin: 2em`. That means the scrollbars belonged to an inner box floating 32px
inside the window instead of to the window, and on a wide listing — a table with
both many rows and many columns — the page showed **two scrollbars side by side
in the middle of the view**. Measured on
`submittal1/package/package_id/_DESC`:

    html/body   scrollHeight == clientHeight  (757 == 757)   document does NOT scroll
    #content    scrollWidth 292,004 vs clientWidth  1,321    horizontal scrollbar
                scrollHeight 10,140 vs clientHeight   550    vertical scrollbar
                margin 32px

The doctype was suspected, but it makes no difference here — measuring the same
page with and without it gives identical results (`BackCompat` and `CSS1Compat`
both scroll on `#content` only).

The layout now lets the **document** scroll, so both scrollbars are the window's,
at the edge of the viewport:

- `body` no longer clips or flexes; `#header` (a new wrapper around the topnav,
  the row-view nav line and the breadcrumbs) and `#footer` are `position: fixed`,
  full width, so they stay pinned and stay viewport-width even when a wide table
  scrolls the document sideways.
- A few lines at the end of `views/page.pug` set the body's top/bottom padding
  from `offsetHeight`, because the header height varies by page (63px, or 81px
  when the row view adds its nav line) and the breadcrumbs can wrap. `style.css`
  carries a fallback padding for when the script does not run. This is the one
  place where a script now participates in layout; the alternative — a hardcoded
  padding per page shape — would have been wrong on every page that does not
  match the assumption.

Measured after the change, on the same page:

    document scrolls: vertical = true, horizontal = true
    #content overflow: visible (it is not a scroll container any more)
    header position: fixed, height 81px, body padding-top 81px
    scrolled to (900, 1500): header top 0, footer bottom 742 = viewport 757 - scrollbar

and across page types (login / table list / table details / row view / error):
`contentTop` 95 or 113 against a header of 63 or 81 — nothing hidden under it in
any case.

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

Caveat resolved: originally verified only structurally (rules served, markup
compatible, templates render). It has since been checked visually with headless
Chrome — the header (logout), breadcrumbs and footer stay put while the content
between them scrolls, on both a long table-details page and a row-detail page
with the floated SQL form. See [issue 15](15-utf8-charset.md) for the setup.

    $ node test/run.js
    7 / 21 / 18 / 62 passed, 0 failed
