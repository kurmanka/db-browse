# 10 — Generated links drop query parameters

**Severity:** medium (navigation loses filters — README "To do")
**Area:** `requestHandlers.js` — `row_detail_make_links`, `breadcrumbs`
**Source:** README, "fix URL building in links properly; e.g. horizontal /
vertical links don't take possible query params into account"

## Symptom

The row view is reachable with extra query-string filters, e.g.
`/notes2/notes/domain/_ASC?name=foo`. The links the page generates — the
vertical/horizontal/one-by-one switcher, "see more", "see all" — are built from
path segments only:

    var base_link = "/" + req.params.db_id
                  + "/" + req.params.table
                  + "/" + req.params.column
                  + "/" + value_or_direction;

so `?name=foo` is silently dropped as soon as the user switches view or paginates.
`breadcrumbs()` has the same problem: its URLs are path-only.

There is a second, smaller bug in the same area: the links are assembled by
string concatenation without `encodeURIComponent`, so values containing `/`, `?`,
`#` or spaces produce broken URLs.

## Fix

1. Build links from the parsed path plus `req.query`, appending a serialized
   query string when present.
2. `encodeURIComponent` each dynamic path segment.
3. Apply the same treatment to `breadcrumbs()` so the trail keeps the filters.
4. Add a small helper (e.g. `buildUrl(req, pathSegments, extraQuery)`) so the
   logic lives in one place; the column-values page can use it too.

## Verification

- With and without query parameters, switching view and "see more"/"see all"
  preserves the filters.
- Values containing reserved characters round-trip.
- Existing navigation still works when there are no query parameters.

## Status

- [x] fixed

## What changed

- New `buildUrl(req, segments, extra)` in `requestHandlers.js`:
  `encodeURIComponent`s every path segment, merges the request's query string
  with optional extra keys, and serializes it once
  (`querystring.stringify`). Exported for tests.
- `row_detail_make_links()` uses it, so the vertical/horizontal/one-by-one
  switcher and "see more"/"see all" keep the filters, and values with `/`, `?`,
  `#` or spaces produce valid URLs instead of broken ones.
- `breadcrumbs()` percent-encodes its segments (it previously concatenated raw
  values). It deliberately does **not** carry the query string: the ancestor
  pages (database, table, column grouping) do not understand the row filters, so
  copying them up would only be noise. The issue's suggestion to carry them
  there was wrong; the row-detail links are where it matters.
- `views/column_values_grouped.pug` built a link from *every* cell, including
  the trailing `count(*)`, producing bogus targets like `/db/table/count/1`. The
  count is now plain text and the value link is absolute and encoded.
- The drill-down link intentionally does not carry `?limit=…`: that page takes
  its limit as a path segment, and a `limit` query key would be treated as a
  column filter by the row route.

## Verification

Live, on `notes2`:

    GET /notes2/notes/domain/_ASC?domain=NOTNULL
      href="/notes2/notes/domain/_ASC/hor/30?domain=NOTNULL"
      href="/notes2/notes/domain/_ASC/one/30?domain=NOTNULL"

    GET /notes2/meta/key
      href="/notes2/meta/key/dim"      (value links, absolute + encoded)
      href="/notes2/meta/key/model"
      (no /count/ links)

`test/drivers.js` covers `buildUrl`; `test/routes.js` asserts that a row view's
links keep the query string and that the grouped page emits no `count` links.

    $ node test/run.js
    7 / 21 / 18 / 62 passed, 0 failed
