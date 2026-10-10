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

- [ ] fixed
