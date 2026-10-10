# db-browse issue index

Issues found while exploring the repository and exercising the running copy, plus
the planned improvements listed at the end of `README.md`.

Each issue is its own numbered file with symptoms, evidence, root cause, the
planned fix, and a status checkbox. Fixes are committed one per issue.

## Found by exploration

| # | Title | Severity | Status |
|---|---|---|---|
| [01](01-routes-test-stale-server.md) | `test/routes.js` can pass against a stale server | high (test integrity) | fixed |
| [02](02-db-schema-pg-dump-command.md) | `/:db/.schema` builds a broken `pg_dump` command | medium | fixed |
| [03](03-sqlite-missing-table.md) | A missing SQLite table renders an empty page with HTTP 200 | medium | fixed |
| [04](04-http-status-codes.md) | "Not found" answers with HTTP 500 | medium | fixed |
| [05](05-postgres-identifier-escaping.md) | Postgres identifiers are not escaped (web UI injection) | high (security) | fixed |
| [06](06-raw-sql-guard.md) | The raw-SQL DDL guard is a bypassable regex | medium | fixed |
| [07](07-addon-loading.md) | Addon loading is broken for the bundled `fun` addon | low | fixed |
| [08](08-misconfigured-database.md) | A misconfigured database shows up healthy, then 500s | low (config) | recorded |

## From the README "To do" / planned improvements

| # | Title | Severity | Status |
|---|---|---|---|
| [09](09-finish-pug-transition.md) | Finish the Pug transition; delete the legacy `view/` | medium | fixed |
| [10](10-links-drop-query-params.md) | Generated links drop query parameters | medium | fixed |
| [11](11-fixed-page-layout.md) | Top and bottom of the page should be fixed | low | open |
| [12](12-json-support.md) | JSON folding / syntax highlighting | low | open |
| [13](13-select-columns-for-view.md) | Select columns for the value/row view | medium | open |
| [14](14-referring-records.md) | Links to referring records (reverse foreign key) | medium | open |
