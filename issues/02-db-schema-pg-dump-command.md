# 02 — `/:db/.schema` builds a broken `pg_dump` command

**Severity:** medium (the feature is entirely broken)
**Area:** `requestHandlers.js` — `produce_db_schema`
**Found:** live, `GET /submittal1/.schema`

## Symptom

    $ curl -b cookies 'http://localhost:1888/submittal1/.schema'
    <h1>Error</h1>
    msg: Error: Command failed: pg_dump -U undefined -h localhost -s submittal1

HTTP 500. `pg_dump` itself is installed at
`/opt/homebrew/opt/libpq/bin/pg_dump`.

## Root cause

`requestHandlers.js:829-835`:

    if (dbconfig.host) { extra_params = " -h " + dbconfig.host; }
    if (dbconfig.port) { extra_params = " -p " + dbconfig.port; }   // overwrites -h

- The port branch **assigns instead of appends**, so a database that sets both
  `host` and `port` silently loses `-h`.
- `-U ` is emitted unconditionally; `submittal1` has no `user`, so the flag
  becomes the literal `-U undefined`.
- The command is assembled as a shell string (`child_process.exec`), so config
  values are interpolated into a shell command line.

## Fix

- Build the command with `child_process.execFile` and an argument array — no
  shell, no quoting bugs, no shell-injection surface.
- Only pass `-U` when a user is configured.
- Push host and port independently (no `=`/`+=` mix-up).
- Pass the password through `env.PGPASSWORD` as now.

## Verification

- `GET /<postgres-db>/.schema` returns the dump when `pg_dump` can reach the
  database, and a clear error otherwise. With no configured `user`, no `-U` flag
  appears in the command.

## Status

- [x] fixed

## What changed

`produce_db_schema` builds an argument array and runs it with
`child_process.execFile`:

- `-U` is added only when a user is configured;
- host and port are pushed independently (no `=` vs `+=` mix-up);
- the environment is inherited (so a bare `pg_dump` still resolves on `PATH`)
  with `PGPASSWORD` added; the old code replaced the whole environment;
- no shell is involved, so config values cannot be split or interpreted.

## Verification

    db_schema command: pg_dump -h localhost -s submittal1
    GET /submittal1/.schema → HTTP 200, real CREATE TABLE statements

Previously the same request produced `pg_dump -U undefined -h localhost -s
submittal1` and HTTP 500.
