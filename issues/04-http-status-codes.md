# 04 — "Not found" answers with HTTP 500

**Severity:** medium (semantics; misleading to clients, caches and humans)
**Area:** `requestHandlers.js`, `start.js`
**Found:** live probing

## Symptom

Everything that is merely absent is reported as a server error:

| Request | Now | Should be |
|---|---|---|
| `GET /nope` (unknown db id) | 500 `No such database: nope.` | 404 |
| value with no matching rows | 500 `No records found to match your filters.` | 404 |
| unknown column | 500 driver error | 404 (or 400) |
| unknown SQLite table | 200 empty page | 404 (issue 03) |

A genuine server fault (e.g. database down) is indistinguishable from user input
that matched nothing.

## Root cause

`showError(req, res, msg, title)` (`requestHandlers.js:130-148`) hard-codes
`res.send(500, html)`. Callers that mean "not found" reuse it.

## Fix

- Give `showError` an optional status, defaulting to 500.
- `prepare_dbconnection` (`start.js:313-317`): unknown `db_id` → 404.
- `show_rows`: an empty result set → 404.
- `noSuchTable` → 404 (it currently `res.send`s with 200).
- Keep 500 for connection failures and unexpected driver errors; issue 08 covers
  giving connect failures a distinct, clearly-labelled status.

## Verification

- The table above returns the "should be" column.
- Existing route tests still pass; add assertions for 404s where a route is
  exercised without a live database.

## Status

- [x] fixed

## What changed

- `showError(req, res, msg[, title[, status]])` takes a status. When none is
  given it infers one: an explicit `msg.status` wins, a message that reads like a
  missing relation/column (Postgres `does not exist`, MySQL `Unknown column`,
  SQLite `no such column`) becomes 404, everything else stays 500. Error objects
  are displayed by message, so a page no longer says "Error: No records found…".
- `start.js`: unknown `db_id` → 404; a configured database that fails to connect
  → 502 (the app is a gateway to the database, and that failure is distinct from
  user input that matched nothing).
- `noSuchTable` → 404.
- `show_rows`: an empty result set is a 404 (`err.status = 404`), not a 500.

`test/routes.js` now asserts the 404s. It discovers a browsable SQLite database
from `config.js` at run time and skips those cases when there is none, the same
way the Postgres/MySQL MCP tests skip without their URLs.

## Verification

| Request | Before | After |
|---|---|---|
| `GET /nope` | 500 | **404** |
| `GET /base` (configured, unreachable) | 500 | **502** |
| `GET /notes2/does_not_exist` | 200 | **404** |
| `GET /notes2/notes/no_such_column` | 500 | **404** |
| `GET /notes2/meta/key/<no match>` | 500 | **404** |
| `GET /notes2`, `GET /notes2/meta`, row views | 200 | 200 |

    $ node test/routes.js
    13 passed, 0 failed
