# 18 — The grouped column page ignores query-string filters

**Severity:** medium (feature gap: the same restriction works one level deeper)
**Area:** `requestHandlers.js` — `_showColumn`; `db_sqlite.js`, `db_postgres.js`,
`db_mysql.js` — `showColumnRequest`; `views/column_values_grouped.pug`
**Source:** user request — `/rep1/tevents/event_type` shows group counts per
value, but, unlike `/rep1/tevents/event_type/<value>`, cannot be restricted with
`?columnB=value`

## Symptom

The row view takes extra `?column=value` pairs as equality filters
(`show_rows` turns every query key except `cols` into a `where` condition). The
grouped column page, one level up, ignored the query string completely: it
always grouped the whole table, so "the event types of user 5" could not be
asked as `/rep1/tevents/event_type?user_id=5`; the only way to see that page's
numbers for a subset was to read them off the row view.

## Fix

1. `showColumnRequest(connection, column, table, limit, where, doneReturn)` in
   all three drivers: an optional `column -> value` map that restricts the rows
   *before* they are grouped, built exactly like the one `showValueRequest`
   already takes (`NOTNULL` means "is not null"; values are bound, identifiers
   are escaped/validated per driver). `where` is optional, so a caller that omits
   it passes the callback in its place — the convention `showValueRequest`
   already uses for `columns`, and what the MCP `column_values` tool does.
2. `_showColumn` builds that map from the query string through the new
   `whereFromQuery(query, reserved)` helper, which `show_rows` now uses too.
   On this page `limit` is the page's own "how many groups" control and `cols`
   belongs to the row view the value links lead to, so both are reserved and
   never become filters.
3. The links the page generates keep the filters: each value link goes to the
   rows behind that value *within the filtered set*
   (`/db/table/column?other=x` -> `/db/table/column/value?other=x`), and
   "show more" keeps them while replacing `limit`. `buildUrl()` learned to
   *remove* a key when `extra` passes null/undefined, which is how the value
   links drop the page's own `limit` (the row view would read it as a column
   filter — see issue 10).
4. `views/column_values_grouped.pug` renders `valueUrls[i]` / `moreUrl`, which
   the handler builds with `buildUrl()`, instead of assembling hrefs by hand.
5. `_showColumn.cache_key` is now `'v2:' + req.url`: a memcached entry written
   before this change carries only part of the locals the template needs.

## Verification

    $ node test/run.js
    7 / 42 / 27 / 62 passed, 0 failed

`test/drivers.js`: the grouped query narrows before grouping, understands
`NOTNULL`, returns no groups when the filter matches nothing, rejects a hostile
filter column (SQLite and Postgres, which also binds the filter value rather
than pasting it), plus `whereFromQuery` and the `buildUrl` removal rule.
`test/routes.js`: a filter that matches nothing leaves the grouped page (200)
without groups, a filter that matches keeps appearing in the generated links,
and `?limit=` is still the page's own control rather than a column filter.

Live, `notes2` (`/notes2/notes/domain`, 3 domains):

    GET /notes2/notes/domain
      ia-writer 3215 · bs-app-src 224 · notes-search-src 16
    GET /notes2/notes/domain?name=README.md
      bs-app-src 68 · notes-search-src 1        (SQLite: 69 README.md rows)
      value link: /notes2/notes/domain/bs-app-src?name=README.md
      show more:  /notes2/notes/domain?name=README.md&limit=40
    GET /notes2/notes/domain?domain=no_such_value_xyz   -> 200, "No data"
    GET /notes2/notes/domain?no_such_col=1              -> 404
    GET /notes2/notes/domain?limit=1                    -> 1 group, no error

A value with spaces and non-ASCII characters
(`?name=— merge recent changes from dev branch.txt`) round-trips through the
filter and into the value links percent-encoded.

## Known limits

- A filter key given twice (`?name=a&name=b`) is an error, as it already was on
  the row view: an equality filter takes one value. Rejecting it with a 400
  would be nicer than the 500 the driver produces — left as a follow-up, and the
  same for both pages.
- Columns literally named `limit` or `cols` cannot be filtered on this page;
  they are the page's own controls (on the row view only `cols` is reserved).
- The page does not print the active filters anywhere; the counts are simply
  narrowed. The row view doesn't either, so this stays consistent.
- The MCP `column_values` tool has no filter argument yet; the driver is ready
  for one.

## Status

- [x] fixed
