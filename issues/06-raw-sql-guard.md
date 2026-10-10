# 06 — The raw-SQL DDL guard is a bypassable regex

**Severity:** medium (the feature is knowingly unsafe, but the guard gives false
assurance)
**Area:** `requestHandlers.js` — `sqlRequest`
**Found:** live, `POST /notes2:sql`

## Symptom

    if ( /ALTER|create|drop/i.exec(l.sql) ) {
        showError(req, res, "Request '" + l.sql + "' can not be executed");
    }

The check scans the whole string, so it

- **blocks innocent queries** that merely mention a keyword — e.g.
  `SELECT * FROM t WHERE note = 'drop'`, or a column named `created_at` when the
  pattern were `create`;
- **misses real DDL**: `TRUNCATE TABLE t`, `GRANT`, `REVOKE`, `RENAME`,
  `REINDEX`, `COMMENT ON`, `CLUSTER`, `REFRESH MATERIALIZED VIEW`;
- **misses multi-statement input**: on Postgres the simple query protocol runs
  `SELECT 1; DROP TABLE t` as a single string, and the guard sees `SELECT`
  first if it is written `SELECT ...; DROP ...` — the `DROP` is caught by the
  scan, but `SELECT 1; TRUNCATE t` is not;
- is defeated by a leading comment (`/* x */ DROP ...`) only for keywords it does
  look for, since the scan is global — but the *first-keyword* intent is still
  not implemented.

`db.getSQL` on Postgres sends the string via the simple protocol, so
multi-statement input really does execute.

## Fix

Replace the substring scan with a tiny leading-keyword check:

1. strip leading whitespace and SQL comments (`-- ...`, `/* ... */`);
2. refuse multiple statements — a `;` followed by anything other than whitespace
   or comments;
3. take the first keyword and refuse it if it is in the DDL blocklist
   (`CREATE`, `ALTER`, `DROP`, `TRUNCATE`, `GRANT`, `REVOKE`, `COMMENT`,
   `RENAME`, `REINDEX`, `CLUSTER`, `REFRESH`);
4. keep allowing `SELECT`, `INSERT`, `UPDATE`, `DELETE` — the box is deliberately
   not read-only (`allow_clear_sql` is the "WARNING, unsafe" switch).

Note: this remains a guardrail, not a security boundary; the switch itself is the
boundary. The fix removes the false positives and closes the trivial misses.

## Verification

- `SELECT * FROM meta` still executes.
- `DROP TABLE meta`, `TRUNCATE meta`, `/* x */ DROP TABLE meta` and
  `SELECT 1; DROP TABLE meta` are refused.
- A query containing the word "drop" inside a string literal is allowed.

## Status

- [x] fixed

## What changed

`requestHandlers.js`:

- `sqlRefusal(sql)` replaces the substring scan: it splits off the first
  statement at the first *top-level* `;` (respecting `'…'`, `"…"`, `--` and
  `/* */`), skips leading whitespace and comments, and looks at the first
  keyword.
- A keyword in `BLOCKED_KEYWORDS` (`CREATE ALTER DROP TRUNCATE GRANT REVOKE
  COMMENT RENAME REINDEX CLUSTER REFRESH`) is refused, as is anything after the
  first statement, and an empty request.
- `SELECT`/`INSERT`/`UPDATE`/`DELETE` are still allowed: the box is deliberately
  not read-only, and `allow_clear_sql` remains the real switch. `DO`, `COPY` and
  `CALL` are deliberately *not* blocked — this is a typo guard, not a security
  boundary — and that is now said in the code.
- The refusal is **400**, not 500.
- `prepare_locals` no longer strips the first `;` from the SQL
  (`req.body.sql.replace(/;/, '')`). That hack mangled the statement shown and
  executed, and left `SELECT 1;; DROP …` a two-statement string after only the
  first `;` was removed.
- `sqlRefusal` is exported and covered by `test/drivers.js`.

## Verification

| Request | Result |
|---|---|
| `SELECT * FROM meta` | 200, rows returned |
| `SELECT * FROM meta WHERE key = 'drop'` | 200 (no false positive) |
| `DROP TABLE meta` | 400 refused |
| `TRUNCATE TABLE meta` | 400 refused |
| `SELECT 1; DROP TABLE meta` | 400 "Only one statement…" |
| `/* c */ DROP TABLE meta` | 400 refused |

`meta` still holds its two rows afterwards.

    $ node test/drivers.js
    18 passed, 0 failed
