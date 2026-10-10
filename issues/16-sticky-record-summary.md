# 16 — Keep the record-summary line in view when the table is scrolled sideways

**Severity:** low (readability)
**Area:** `views/row_detail_wrapper.pug`, `static/css/style.css`
**Reported:** the "Total rows: 30, shown above: 30" line scrolls off to the left
as soon as the page is scrolled right to reach further columns

## Context

Since [issue 11](11-fixed-page-layout.md) the *document* scrolls horizontally,
so a wide record listing is reached by scrolling the whole page sideways. The
summary line sits below the table, left-aligned at the table's first column, so
scrolling right carries it off the left edge — just when you are reading the
last columns and want to know how much of the result set you are looking at.

## Fix

`position: sticky; left: 2em` on the line keeps it against the content's left
edge while the page scrolls sideways. Two details make it actually work:

1. **A sticky box can only move within its containing block.** The line's
   containing block is `#content`, whose box is only as wide as the viewport
   even though the table overflows it, so the line had about 1,100px of room and
   then stopped. Wrapping the table and the line in `.records { width:
   min-content }` makes the containing block as wide as the table.
2. **`min-`, not `max-content`.** `.records { width: max-content }` also made
   the *table* lay out at its preferred width instead of wrapping, which widened
   the document from 13,515px to 32,182px — a lot more sideways scrolling to
   reach the same columns. `min-content` is the table's own rendered width, so
   the table lays out exactly as before.

`min-width: 100%` keeps `.records` full-width when the table is narrower than
the page, so narrow tables (which do not scroll sideways at all) are unaffected.

## Verification

Measured with headless Chrome, on `submittal1/package/package_id/_DESC`
(document 13,500px wide, viewport 1,400px):

| scrollX | line's left edge, before | after |
|---|---|---|
| 0 | 32 (visible) | 32 (visible) |
| 4,000 | −3,968 (off screen) | 32 (visible) |
| 12,115 (max) | −10,971 (off screen) | 32 (visible) |

The line is 209px wide, so `left = 32` with `right = 241` is comfortably inside
the 1,400px viewport at every offset.

Table layout is unchanged by the wrapper — 13,468px wide, document 13,500px
against a 13,515px baseline without it. A narrow case (`notes2/meta`, 2 columns)
is also unchanged: table 700px, `.records` 1,336px (full width), no sideways
scrolling.

`node test/run.js`: 7 / 29 / 21 / 62 passed, 0 failed.

One caveat about the method: `--screenshot` after a programmatic scroll came out
mis-composited in this headless setup (blank, or offset by the scroll amount),
so the evidence above is geometry read back with `--dump-dom`
(`getBoundingClientRect()` at several scroll offsets), not a picture.

## Not done

The line still scrolls *vertically* with the table — it is visible when you are
at the end of the listing, which is where it has always been. If it should stay
on screen while scrolling through the rows as well, the change is to pin it as a
status bar above the footer (`position: fixed`, `bottom: <footer height>`)
rather than stick it to the left; that is a different design decision and was
not asked for.

## Status

- [x] fixed
