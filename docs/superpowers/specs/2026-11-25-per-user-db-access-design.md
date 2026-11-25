# Per-user database access — design (short)

## Why

Different people get different databases, in the web UI and over MCP alike.
The owner's own account(s) must see every database. Table-level limits are out
of scope.

## Approaches considered

- **A. Separate YAML access file keyed by user.** Edits apply without a
  restart, and one person's access is visible in one place. Not picked: the
  owner prefers keeping it in `config.js`.
- **B. `allow:` list on each `config.db` entry, plus a global superuser list.**
  Picked. No new file or loader; the rule sits next to the database it guards.
  Changes need a restart.
- **C. YAML file keyed by database.** Same trade-offs as A.

## Design

```js
exports.superusers = ['ivan@example.com', 'ivan'];   // see every database

exports.db = {
    sales: { type: 'postgres', ..., allow: ['ann@example.com', 'group:analysts'] },
    misc:  { type: 'sqlite', ... },                   // no allow: everyone
};
```

- **Identity.** With OIDC: the verified email (lower-cased) and the groups
  claim, from the web session or the MCP token. With password login: the
  username. Session-stored groups are needed for the web UI, so the OIDC
  callback saves them next to `req.session.user`.
- **Matching.** An `allow` entry matches the user's email or username
  (case-insensitive), or one of their groups when written `group:<name>`.
  Superusers are matched the same way and may see everything.
- **No `allow` key:** the database is open to every signed-in user, as today.
  This keeps existing configs working. `allow: []` means superusers only.
- **Static MCP token** (deprecated admin fallback): sees everything.
- **Hidden means not there.** A database the user may not use is left out of
  the web database list and MCP `list_databases`. Any direct use gives "No
  such database", from `prepare_dbconnection` (web) and `dbEntry()` (MCP).
  Its name is never shown.
- **One helper** (for example `access.js`: `canUse(config, user, dbId)`)
  holds the rule. Web and MCP both call it.
- **Startup check.** Log a warning for an `allow` or `superusers` value that
  isn't an array of strings.
- **Docs.** `config.js.example` and `CLAUDE.md`.

## Left to the builder

- Which other places reach a database by id (SQL history listings, addon
  routes, pg_dump). They must go through the same check, or be listed as
  known gaps.
- Tests: the helper, plus web route and MCP cases for allowed, denied and
  superuser access.
