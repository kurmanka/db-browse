# 17 — Compact row view: show only the start of long text and JSON values

**Severity:** low (feature — readability)
**Area:** `views/row_detail_wrapper.pug`, `static/js/row-compact.js`,
`static/js/json-format.js`, `static/css/style.css`, `requestHandlers.js`
**Reported:** while viewing several records, a column holding a lot of text or
JSON makes every row tall, so the page is mostly scrolling. Often only the
beginning of each value is needed to tell the records apart.

## Design

A **compact ("short values") mode**, on by default, turned off with a checkbox
in the row view's fixed header, and remembered in a cookie:

- `requestHandlers.js` reads the cookie (`dbb_compact=0` means off; anything
  else, including no cookie, means on) and publishes `compact` and
  `compact_chars` into `res.locals`, so the checkbox is rendered already in the
  right state and the first paint agrees with it. `config.compact_chars`
  (default 80) is the number of characters the short form keeps; `0` switches
  the feature off and hides the checkbox.
- `views/row_detail_wrapper.pug` renders the checkbox in `nav2`, which lives in
  the fixed header, so the switch stays reachable while a page of tall records
  is scrolled. It is `hidden` until the script runs: without JavaScript a switch
  that cannot do anything should not be offered, and the page then behaves
  exactly as before.
- `static/js/row-compact.js` does the actual work. It remembers every cell's
  full text **at parse time**, before `json-format.js` replaces a JSON cell with
  its tree, and then either shows the short form or leaves the page alone.
  Clicking a short cell expands that one value in place — plain text as it is,
  JSON as the issue-12 tree — and a plain text cell folds back on a second
  click. An expanded JSON cell gets a `short` link next to `raw` to fold back.

Why client-side, and not truncating in the template: expanding "within the cell"
needs the full value already in the document, so a server-side short form would
either ship the full value hidden anyway or need a request per click. The page
already sends full values; what changes is the layout. Applying it in the
browser also makes flipping the switch instant — no reload, so the scroll
position that the feature exists to protect is never lost.

## What changed

- `requestHandlers.js`: `COMPACT_COOKIE` / `COMPACT_DEFAULT_CHARS`,
  `compactChars()` and `compactOn()`, both exported for the tests; `compact`
  and `compact_chars` added to `res.locals`.
- `views/row_detail_wrapper.pug`: the `short values` checkbox in `nav2`, and
  `row-compact.js` loaded before `json-format.js`.
- `static/js/row-compact.js` (new): the preview helpers (`previewText`,
  `previewJson`), the cookie, the click handling and the switch. Whitespace is
  flattened to a single space in a preview, so the short form is one scannable
  line, and a JSON preview is built from the compact serialisation rather than
  the pretty-printed block the server sent.
- `static/js/json-format.js`: exposes `renderCell()` and skips cells already
  showing the short form, so a tree is only built for a value actually shown in
  full. Its tree work is now driven from `row-compact.js` as well.
- `static/css/style.css`: the switch, the pointer/hover affordance on a short
  cell, and the `short` link.
- `config.js.example`: `exports.compact_chars = 80;` documented (commented out,
  since the default is the same).

Cells that hold more than a bare value are left alone: a foreign-key link, the
referring-records list, a `null`. Rewriting those as text would throw markup
away, and clamping a link would fight the click that follows it.

## Alternatives considered

- **Truncating in the template, toggling with a page reload.** Loses the scroll
  position on every flip, which is what the feature is for; and the full value
  would still have to be shipped (or fetched per click) to expand in place.
- **CSS only** (`text-overflow: ellipsis`, `max-width: 80ch`). No character
  count, no JSON case, and no way to tell "clamped" from "short".
- **A `<details>` per cell.** Expanding works without JavaScript, but the mode
  cannot be flipped for the whole page without a reload, and it nests badly
  inside the JSON tree.

## Verification

`node test/drivers.js` covers the pure helpers: trimming, whitespace flattening,
the compact JSON preview, the cookie, and the config default/sanitiser/off
switch (including that `compact_chars: 0` can never be on).

`node test/routes.js` fetches a real row view and asserts the switch is
rendered, checked by default, carries `data-limit="80"`, that
`Cookie: dbb_compact=0` unchecks it, and that the script is served.

The interaction was exercised in headless Chrome against the real page (a saved
`notes2/notes` row view, its `/_/` asset URLs rewritten to `file://`), with
programmatic clicks and the resulting DOM read back:

- compact on: 30 of 30 JSON cells show the short form, no trees built;
- click a JSON cell → tree with `raw · short`; click `short` → the short form
  again and the tree gone;
- click a text cell → full value (longer), click again → the same preview;
- switch off → no short forms left, every JSON cell a tree; switch on again →
  short forms back, no stale trees;
- the same three probes pass in all three views (vertical, horizontal, one by
  one).

Visually confirmed with `--screenshot`: the `vector` column of
`notes2/notes` (a 50 KB `{"type":"Buffer","data":[…]}` per row) collapses from a
page 1.5 MB of JSON to one line per record, the snippet column of the same page
shows `…`-terminated previews, and unchecking the switch restores the full
values.

`node test/run.js`: 7 / 35 / 24 / 62 passed, 0 failed.

## Status

- [x] fixed
