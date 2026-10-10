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

- [ ] fixed
