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

- [ ] fixed
