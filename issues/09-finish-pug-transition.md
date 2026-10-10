# 09 — Finish the Pug transition; delete the legacy `view/` folder

**Severity:** medium (maintainability — README "To do")
**Area:** `requestHandlers.js`, `view/`, `views/`
**Source:** README, "finish the transition to pug templates; delete the legacy
view/ folder"

## Current state

Two template engines are live at once. Every page must be read with knowledge of
which engine rendered it.

**Pug** (`views/*.pug`, rendered by `res.render` / `finish_pug`):

- `login.pug` — `login()` / `loadUser`
- `listDatabase.pug` — `selectDatabase()`
- `tableList.pug` — `_list_tables` (`pug = true`)
- `column_values_grouped.pug` — `_showColumn` (`pug = true`)
- `row_detail_{ver,hor,one}.pug` — `show_rows`
- `sqlHistory.pug` — `sqlHistory()`

**JUST** (`view/*.html`, rendered by `just.render` / `respond` / `finish`):

- `tableDetails.html` — `table_details()`
- `totalRecords.html` — `showPageTotalRecords()` (streamed after `tableDetails`)
- `showSqlRequest.html` — `sqlRequest()`
- `sqlDetails.html` — `sqlDetails()`
- `msg.html` — `sqlSave()`, `sqlRemove()`, and `showError()` (via `just.render`)
- `db_schema.html` — `produce_db_schema()`

**Dead** (superseded by the Pug files, no longer referenced): `login.html`,
`listDatabase.html`, `tableList.html`, `columnData.html`, `sqlHistory.html`,
`parent.html`.

The observable difference is not just internals: JUST output has unquoted
attribute values (`href = /notes2/meta/value`), which is invalid enough to matter
for tooling.

## Fix

1. Port the six live JUST templates to Pug under `views/`.
2. Keep the two-part streaming of the table-details page: render
   `tableDetails.pug`, write it, then render `totalRecords.pug` and end — or fold
   the record count into one template once `rowsCounter` can run first.
3. Move `showError` from `just.render('msg', ...)` to a `msg.pug`.
4. Delete `view/` and the JUST dependency wiring (`respond`, `finish`,
   `just_usecache`, the `JUST` require) from `requestHandlers.js`; keep `finish_pug`
   (possibly renamed) as the only path.
5. Drop the now-unused `just` dependency from `package.json`.
6. Update `CLAUDE.md` (it documents the two-engine legacy situation).

## Verification

- The affected routes render: `/:db/:table`, `/:db:sql` (execute/save/remove),
  `/:sql/:id`, `/:db/.schema`, and every error page.
- `grep -r "just" requestHandlers.js` finds nothing; `view/` is gone.
- The test suite still passes.

## Status

- [ ] fixed
