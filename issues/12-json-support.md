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

- [ ] fixed
