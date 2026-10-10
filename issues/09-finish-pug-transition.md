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

- [x] fixed

## What changed

Six templates were ported to `views/*.pug`, matching what the JUST ones rendered:

| Was | Now |
|---|---|
| `view/tableDetails.html` | `views/tableDetails.pug` (extends `page`) |
| `view/totalRecords.html` | `views/totalRecords.pug` (fragment, still appended) |
| `view/showSqlRequest.html` | `views/showSqlRequest.pug` |
| `view/sqlDetails.html` | `views/sqlDetails.pug` |
| `view/msg.html` | `views/msg.pug` |
| `view/db_schema.html` | `views/db_schema.pug` |

- `requestHandlers.js`: `respond()` and `finish()` (and the `JUST` require) are
  gone; the remaining callers use `finish_pug()`. `showError()` renders
  `msg.pug`. `show_rows` and `cache_wrapper` no longer branch on template
  extension/`handler.pug` — everything is Pug.
- The two-part table-details response is preserved: `tableDetails.pug` is
  written, then `totalRecords.pug` appends the row count via jQuery.
- The unused `handler.pug` flags and the `just` dependency are removed.
- `view/` is deleted; `CLAUDE.md` describes one template engine now, and
  `README.md` drops the finished to-do item.

Dead templates that nothing referenced (`login.html`, `listDatabase.html`,
`tableList.html`, `columnData.html`, `sqlHistory.html`, `parent.html`) went with
the directory.

## Verification

Every affected route was checked live after the port:

| Route | Result |
|---|---|
| `/:db/:table` | 200; headers, column links, arrows, status/SQL, "— N records" |
| `/:db:sql` (Execute) | 200; `.sql` block and results table |
| `/:sql/:id` | 200; form renders |
| `/:db/.schema` | 200; Prism-highlighted dump |
| error page | 200/4xx; `#msg` renders |
| `/:sql/999` (unknown) | 200, as before |

Rendering is now consistent with the other Pug pages (quoted attributes, e.g.
`<td class="data">` instead of `<td class = 'data'>`).

    $ node test/run.js
    7 / 20 / 16 / 62 passed, 0 failed
