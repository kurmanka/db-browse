# 14 — Links to referring records (reverse foreign key)

**Severity:** medium (feature — README "To do")
**Area:** `db_postgres.js` (`getTableDetails`), `requestHandlers.js`
(`table_details`, `show_rows`), `views/`
**Source:** README, "add links for referring records — e.g. when looking at a
product, find all documents referring to this product, or when looking at a
company, find all products of that company (the reverse of foreign key
`references` relation)"

## Current state

`db_postgres.js` already collects the *incoming* foreign keys in
`getTableDetails` — the "referenced" query selects constraints where
`confrelid = <table>` — and `table_details` stores it as `res.locals.referenced`.
It is rendered on the table-details page as information, but nothing links from a
row to the rows that point at it:

- `db_map` (`views/inc/row_detail_value.pug`) walks *outgoing* foreign keys only
  (`tmap.fk[key]`), so a value can link to its parent record, never to its
  children.
- The web UI has no route that means "rows of table B whose column c equals this
  value" other than the existing `/:db/:table/:column/:value`, which is exactly
  the primitive needed — this is mostly a matter of exposing it.

## Fix

1. On the row-detail page, for the current table, list the tables/columns that
   reference it (from `referenced`, which the driver already returns for
   Postgres; SQLite/MySQL expose foreign keys differently and can follow later).
2. For each, link to `/:db/:referencing_table/:referencing_column/:value` using
   the current row's referenced column value.
3. Derive the referenced column from the constraint definition; `confkey` /
   `pg_get_constraintdef` gives it, but the current query returns only
   `conname`, `conrelid::regclass`, `condef` — it needs the referring column (or
   the target column) added.
4. Reuse the identifier validation from issue 05 and the link builder from
   issue 10.
5. Guard against tables with no stable key: only offer the link when there is a
   value to match on.

## Verification

- Opening a row in a parent table shows links to the child rows that reference
  it, and following one lists exactly those rows.
- Tables with no incoming foreign keys show nothing extra.
- No SQL is built from unvalidated identifiers.

## Status

- [x] fixed (Postgres; MySQL/SQLite not implemented)

## What changed

- New driver method `getReferencing(connection, table, done)` returning
  `[{ constraint, table, column, referenced_column }]`. Postgres implements it
  with one query over `pg_constraint` (`confrelid = $1::regclass`, `contype =
  'f'`), mapping `conkey`/`confkey` through `pg_attribute`; **composite keys are
  skipped**, since a single-value link cannot express them. `db_mysql.js` and
  `db_sqlite.js` return `[]` (documented in the code): SQLite's
  `foreign_key_list` only lists a table's outgoing keys, and there is no MySQL
  server here to verify an `information_schema` query against.
- `show_rows()` fetches the columns and the incoming keys together (one extra
  query on Postgres) and builds, for every record, one link per incoming key:
  `/:db/:referring_table/:referring_column/:value`, with the value taken from
  that record and the URL made by `buildUrl` (issue 10), so it is encoded.
- `row_detail_hor.pug` adds a "Referenced by" column (header plus a cell per
  record); `row_detail_one.pug` adds a "Referenced by" block under each record.
  The `ver` view is unchanged: it is column-oriented, with one cell per record,
  so a per-record link has nowhere to go.
- `CLAUDE.md` documents the new method.

## Verification

Live, on `submittal1` (`user_account` is referenced by 20 single-column keys):

    GET /submittal1/user_account/user_id/_ASC/hor/2
      <th>Referenced by</th>
      href="/submittal1/access_right/given_to_user_id/1"   (class="ref")
      href="/submittal1/access_right/user_id/1"
      href="/submittal1/company_account/admin_user_account_id/1"
      …

    GET /submittal1/user_account/user_id/_ASC/one/1
      <div class="refs"><b>Referenced by:</b> … </div>

    GET /submittal1/access_right/given_to_user_id/1     (following a link)
      200, "Results from access_right", 2620 rows

A `notes2` (SQLite) row view renders no "Referenced by", as intended.

One bug was found and fixed while verifying: `array_agg(attname)` comes back
from `pg` as the raw `{a,b}` **string** (there is no parser for `name[]`), so the
single-column check dropped every row. The aggregate now casts to `::text`.

`test/drivers.js` covers the mapping (single-column kept, composite and
null-array rows dropped) and that the table name is passed as a parameter.

    $ node test/run.js
    7 / 29 / 20 / 62 passed, 0 failed
