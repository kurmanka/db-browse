# 08 — A misconfigured database shows up healthy, then 500s on click

**Severity:** low (local configuration, not a code defect)
**Area:** `config.js` (gitignored, the user's), `start.js`
**Found:** live, `GET /base`

## Symptom

`config.js` declares `base` as a Postgres database named `base`, which does not
exist on the local server. The home page lists `base` like any other database;
every link on it then returns HTTP 500:

    Error connecting to the database 'base'. error: database "base" does not exist

## Assessment

The database list cannot know a database is unreachable without connecting to
every one of them on every page load, so "listed as healthy" is expected. The
code-side improvements are:

- a *bad `db_id`* should be a 404, while a *database that fails to connect* is a
  server-side problem and may stay 5xx — but it should say so distinctly and
  consistently (see issue 04);
- the message already names the database and the driver error, which is good;
  keep that.

No change to `config.js`: it is gitignored and belongs to the user. The
disposition is to fix the status/message split in issue 04 and otherwise record
this as a configuration mistake (`base` should point at an existing database, or
be removed/commented out).

## Fix

- Covered by issue 04 (404 for unknown ids, distinct status for connect
  failures).
- Optionally note in `config.js.example` that entries are advertised whether or
  not they can be reached.

## Status

- [x] recorded — code part landed with issue 04

## What changed (issue 04)

- unknown database id → 404 `No such database: <id>.`
- configured but unreachable database → 502 `Error connecting to the database
  '<id>'. <driver error>` — verified live for `base`.

`config.js` itself was left alone. The remaining action is the user's: point
`base` at an existing database, or remove/comment the entry.
