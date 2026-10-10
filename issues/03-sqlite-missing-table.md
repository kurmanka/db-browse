# 03 — A missing SQLite table renders an empty page with HTTP 200

**Severity:** medium
**Area:** `db_sqlite.js` — `getTableDetails`
**Found:** live, `GET /notes2/does_not_exist`

## Symptom

Requesting a table that does not exist returns **HTTP 200** and an empty table
page. The `noSuchTable` handler ("No such table: X") never runs. Postgres and
MySQL do error here, so their path works.

## Evidence

    $ curl -b cookies 'http://localhost:1888/notes2/does_not_exist'
    <h1>Table does_not_exist</h1>
    <table class='light'> ... empty ... </table>
    HTTP 200

## Root cause

`db_sqlite.js:113-139`:

- columns come from `PRAGMA table_info(<table>)` — for a missing table SQLite
  returns an **empty result set**, not an error;
- the create statement comes from `SELECT sql FROM sqlite_master WHERE name=?` —
  likewise empty, not an error.

So `async.parallel` reports success with `[[], []]`, and `table_details`
(`requestHandlers.js:334-346`) treats that as a real table.

## Fix

In the status branch, treat "no row in `sqlite_master`" as not-found and call
`done(new Error("Table '<name>' not found"))`. `table_details` already routes
errors to `next()`, which reaches `noSuchTable`.

Worth handling at the same time: a table that exists but whose `sql` is `NULL`
(e.g. some internal tables) should still render, not error.

## Verification

- `GET /notes2/does_not_exist` reaches `noSuchTable`.
- `GET /notes2/meta` still renders columns and the create statement.

## Status

- [x] fixed

## What changed

`db_sqlite.getTableDetails` treats an empty `sqlite_master` row as not-found and
calls back with `Table '<name>' not found`, so `table_details` falls through to
`noSuchTable`.

A new `test/drivers.js` (wired into `test/run.js`) covers the SQLite driver
without a server, including this case — it fails against the old code.

## Verification

    GET /notes2/does_not_exist → "No such table: does_not_exist"
    GET /notes2/meta          → columns + "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)"

    $ node test/drivers.js
    6 passed, 0 failed

(The status code for the "no such table" page is still 200 here; issue 04 makes
it 404.)
