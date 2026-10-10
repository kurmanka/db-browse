# 13 — Select which columns to show in the value/row view

**Severity:** medium (feature — README "To do")
**Area:** `requestHandlers.js` (`show_rows`), `db_*.js`
(`showValueRequest`), `views/row_detail_*.pug`
**Source:** README, "add selecting columns for view in
/:db/:table/:column/:value"

## Current state

`show_rows` always runs `SELECT *`, and the row templates render every column.
Wide tables (dozens of columns, JSON blobs) are unreadable, and there is no way
to narrow them.

## Fix

1. Accept a `cols` query parameter (comma-separated column names) on the row
   routes, validated against the table's real columns.
2. Extend the driver interface — `showValueRequest(connection, table, where,
   order_limit_offset, done)` — so a column list can be passed; default to `*` to
   keep all other callers unchanged. Quote each column per driver
   (`mysql.escapeId`, sqlite `escapeId`, Postgres `ident` from issue 05).
3. Add a small column-picker form to `views/row_detail_wrapper.pug`: checkboxes
   for each column, submitted via GET, preserving the existing filters and view.
4. Feed the selection back through the link builder from issue 10 so switching
   views keeps the chosen columns.
5. Show a clear error for an unknown column rather than a driver error.

## Verification

- Selecting a subset renders only those columns; the links (view switch, more,
  all) keep the selection.
- Without `cols` the page is unchanged.
- Invalid column names are rejected with a clear message and no SQL executed.

## Status

- [x] fixed

## What changed

- Driver interface: new `getTableColumns(connection, table, done)` — a
  zero-row select read for its result metadata (Postgres/MySQL) and
  `PRAGMA table_info` (SQLite).
- `showValueRequest(..., columns, done)` takes an optional array of column
  names. A caller that omits it may pass the callback in its place, so the MCP
  layer and existing calls are unchanged. SQLite and MySQL quote each name with
  their `escapeId`; Postgres always double-quotes them (`quoteIdent`), because
  these come from the database, not a URL: a picker value `MyCol` must not be
  folded to `mycol` the way a URL identifier is.
- `show_rows()` accepts `?cols=a,b` or `?cols=a&cols=b` (`parseCols`), fetches
  the table's real columns, and rejects any requested name that is not an exact
  match with **404 `Unknown column(s): …`** — a clear error, and no SQL built
  from it. `cols` is the first entry in `RESERVED_QUERY`, so it is not mistaken
  for a column filter (every other query key still filters, as before).
- `views/row_detail_wrapper.pug` gets a `<details>` column picker: a checkbox
  per column, submitting the same path and the current filters (minus `cols`).
  It is only shown when the table has more than one column.
- Because the existing links are built with `buildUrl` (issue 10), the selection
  is carried into the view switcher and "see more"/"see all" automatically.
- `CLAUDE.md` documents the new driver method and signature.

## Verification

Live, on `notes2/notes` (9 columns):

    GET /notes2/notes/domain/_ASC
      <summary>Columns: 9 of 9</summary>, a checkbox per column
    GET /notes2/notes/domain/_ASC?cols=domain&cols=name
      200, 2 <th>, <summary>Columns: 2 of 9</summary>
      links: /notes2/notes/domain/_ASC/hor/30?cols=domain&amp;cols=name
    GET /notes2/notes/domain/_ASC?cols=nope
      404 "Unknown column(s): nope"

`test/drivers.js` covers `getTableColumns`, a selected-column query, `parseCols`
and the Postgres quoting; `test/routes.js` covers the picker, the narrowing and
the unknown-column 404.

    $ node test/run.js
    7 / 28 / 20 / 62 passed, 0 failed
