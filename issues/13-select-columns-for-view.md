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

- [ ] fixed
