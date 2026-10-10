# 05 — Postgres identifiers are not escaped (web UI injection surface)

**Severity:** high (security)
**Area:** `db_postgres.js`
**Found:** reading the driver after the MCP layer's `checkIdentifiers` drew
attention to it

## Symptom

`db_postgres.js:175-179`:

    function escape (text) {
        text = text.replace(/\%20|;|,|\%22|\%27/g, '\\$&');
        return text;
    }

This is not identifier quoting. It backslash-escapes a few characters and the
result is concatenated straight into SQL:

    select * from <escape(table)> where <escape(col)> = $1

`table`, `column`, `order_by` and every `where` key come from the URL
(`/:db/:table/:column/:value`, and query keys become `where` columns). Nothing
validates them. It is only harmless in the current config because
`allow_clear_sql = true` already permits arbitrary SQL; on a config with clear
SQL off, the structured routes remain an injection surface.

Additionally three `regclass` queries interpolate the table name into a
**single-quoted string literal** (`db_postgres.js:72-99`):

    ... WHERE c.confrelid = '" + escape(table) + "'::regclass ...

A double-quoted identifier may contain a single quote, which breaks out of the
literal.

## Why not simply double-quote every identifier

The web UI deliberately accepts schema-qualified (`sales.orders`) and explicitly
quoted or mixed-case (`"MyTable"`) names, and unquoted names are lower-cased by
Postgres. Unconditional double-quoting would change which table resolves.

## Fix

1. Add an `ident(name)` validator that accepts exactly what the app supports:
   - a plain, optionally schema-qualified name
     (`^[A-Za-z_][A-Za-z0-9_$]*(\.[A-Za-z_][A-Za-z0-9_$]*)?$`), passed through
     unchanged so Postgres keeps its current case-folding behaviour;
   - a strictly double-quoted, optionally qualified name
     (`^"[^"]+"(\."[^"]+")?$`), passed through so the user's own quoting stands;
   - anything else → error.
2. Use it for every identifier position (table, column, `order_by`, `where`
   keys) in `showColumnRequest`, `showValueRequest`, `rowsCounter`,
   `getTableDetails`.
3. Convert the three `regclass` queries to parameters (`$1::regclass`) instead of
   interpolating a literal.
4. Report validation failures through `doneReturn(err)` — do not throw
   synchronously out of an async task.

## Verification

- Normal browsing (plain, schema-qualified, quoted mixed-case) is unchanged.
- Hostile values such as `t; DROP TABLE x--`, `1) from (select 1) x --` produce a
  clear error and no SQL execution.
- The MCP tests keep passing (their `checkIdentifiers` stays as a second layer).

## Status

- [ ] fixed
