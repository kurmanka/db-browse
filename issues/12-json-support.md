# 12 — JSON folding / syntax highlighting

**Severity:** low (feature — README "JSON support")
**Area:** `views/inc/row_detail_value.pug`, `static/js/`, `static/css/`
**Source:** README, "Currently, the JSON values in a database are output in an
indented form, but with no syntax highlighting or anything on top."

## Current state

`views/inc/row_detail_value.pug` detects a non-Date object value and renders it
as

    - value = JSON.stringify( value, null, 4 )
    - type = 'json'

and then prints it inside a `<td class="data json">`. The styling stops there:
there is no highlighting, no collapsing, and a large JSON document dominates the
row.

Note the detection is `typeof value === 'object'` and not a Date — that covers
JSON/JSONB columns and arrays, but also catches anything else the driver returns
as an object.

## Fix

- Add a small client-side formatter (a local script under `static/js/`, no CDN)
  that turns a `.json` cell's text into a collapsible tree with syntax
  highlighting; a few hundred lines at most, with no dependency.
- Keep the raw text in a `<pre>` so copy/paste and no-JS rendering still work.
- Collapse deep/long values by default with a "show" affordance, and show a short
  summary for arrays/objects.
- Style it in `static/css/style.css`.
- Alternative considered: `json-formatter-js` / `json-view`, as the README
  suggests; a local script avoids adding a runtime dependency and a network
  fetch.

## Verification

- A JSON column renders highlighted and collapsible; invalid/non-JSON text in a
  `.json` cell is left as plain text.
- The page still works with JavaScript disabled.

## Status

- [x] fixed

## What changed

- New `static/js/json-format.js`, loaded only by `views/row_detail_wrapper.pug`
  (row-detail pages are the only place `.json` cells appear). No dependency, no
  CDN.
- It finds every `td.json`, parses its text, and replaces the pretty-printed
  block with a collapsible tree: coloured keys/strings/numbers/booleans/nulls,
  a `{n}`/`[n]` summary on containers, click-to-expand, and deep (`MAX_DEPTH = 3`)
  or large (`MAX_ITEMS = 20`) containers collapsed by default.
- A "raw" link swaps the tree for a `<pre>` holding the original text, so
  copy/paste still gives exactly what the driver produced. A cell whose text is
  not valid JSON is left untouched, and with JavaScript disabled nothing changes.
- The tree building (`buildTree`) is a pure function returning a plain
  description, separate from the DOM work, so it is unit-tested in Node.
- `static/css/style.css`: the old `.json { white-space: pre }` rule is kept for
  the no-JS case; the tree styles sit next to it.
- `README.md`'s "JSON support" section now describes the feature instead of
  proposing libraries, and the item is gone from "To do".

## Verification

- A real `jsonb` column renders as a JSON cell:
  `GET /submittal1/file/flags/_ASC?flags=NOTNULL` → 200, `td.json` cells
  present, `json-format.js` included, and the script is served (200).
- `test/drivers.js` covers `buildTree`: nesting, array indices, commas,
  primitive rendering, summaries, and the depth/size collapse thresholds.

Not verified here: the in-browser interactivity (expanding, the raw toggle,
the colours). The logic is tested and the CSS/JS are served; a click-through in
a browser is the remaining step.

    $ node test/run.js
    7 / 24 / 18 / 62 passed, 0 failed
