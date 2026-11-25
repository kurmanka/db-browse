# Per-user Database Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restrict which databases each user can see and use, in the web UI and over MCP, through an `allow` list on each `config.db` entry plus a global `config.superusers` list.

**Architecture:** One new module, `access.js`, holds the rule. The web UI checks it in `prepare_dbconnection` and filters `databaseList` in `prepare_locals`. MCP passes the caller's identity from the SDK's `authInfo` into each tool, which checks it in `dbEntry()` and filters `list_databases`. A database the user may not use behaves exactly like one that does not exist.

**Tech Stack:** Node, Express 4, Pug, MCP SDK. Tests are plain node scripts run by `test/run.js`.

**Spec:** `docs/superpowers/specs/2026-11-25-per-user-db-access-design.md`

## Global Constraints

- A database without an `allow` key is open to every signed-in user, as today.
- `allow: []` means superusers only.
- `allow` entries and `superusers` entries match an email or username, case-insensitively, or a group when written `group:<name>` (group names are compared exactly, as `allowlist.js` does).
- The static `config.mcp.token` sees every database.
- A denied database gives exactly the same error as an unknown one: web `"No such database: <id>."` with status 404, and MCP `No such database: <id>` (the existing `dbEntry` message). It is never listed.
- `allow` / `superusers` values that are not arrays of strings are logged as warnings at startup. A malformed `allow` fails closed (superusers only). A malformed `superusers` is treated as an empty list.
- Keep the code ES5-style (`var`, `function`), matching `allowlist.js` and `mcp.js`.

## Review Focus

1. **A database id such as `__proto__` or `constructor`** must give "No such database", never a crash or access. Covered in the Task 1 unit tests.
2. **Mixed-case entries** (`Ann@Example.com` in `allow`) must match the login `ann@example.com`. Covered in Task 1.
3. **A password-login session has no `groups`**, and the rule must not throw on that. Covered in Task 1 (`who` with `groups` undefined).
4. **No authentication configured** (`session.user` undefined): only databases without `allow` are usable. Covered in Task 1 (`who` with no name).
5. **A saved SQL query whose `dbid` is hidden**, reached by its numeric id at `/:sql/<id>`, must give 404. Covered in Task 2.

---

### Task 1: `access.js` — the rule

**Files:**
- Create: `access.js`
- Create: `test/access.js`
- Modify: `test/run.js` (add `access.js` to the list)
- Modify: `config.js.example` (document `exports.superusers` near the auth settings, and `allow` in the `exports.db` example)
- Modify: `CLAUDE.md` (add `exports.superusers` to the Config block, and a short "Per-user database access" paragraph under Authentication naming `access.js`)

**Interfaces:**
- Produces:
  - `access.ALL`: a frozen sentinel object. A `who` equal to it may use every database (the static MCP token).
  - `who` shape: `{ name: string|undefined, groups: string[]|undefined }`.
  - `access.fromSession(session) -> who`: `{ name: session && session.user, groups: session && session.groups }`.
  - `access.canUse(config, who, dbId) -> boolean`: false when `dbId` is not an own property of `config.db`; true for `ALL` and for superusers; true when the entry has no `allow` key; otherwise true when `who` matches an entry in the `allow` array.
  - `access.visible(config, who) -> object`: a new object holding the `config.db` entries `canUse` allows, in the original key order.
  - `access.problems(config) -> string[]`: one warning per malformed `superusers` or per-db `allow`.

- [ ] **Step 1: Write the failing tests in `test/access.js`**, using the `ok()` / pass-fail counter style of `test/mcp.js` and exiting non-zero on failure. Fixture config:

```js
const config = {
  superusers: ['Root@Example.com', 'group:admins', 'ivan'],
  db: {
    open:   { type: 'sqlite' },
    sales:  { type: 'sqlite', allow: ['Ann@Example.com', 'group:analysts'] },
    locked: { type: 'sqlite', allow: [] },
    broken: { type: 'sqlite', allow: 'ann@example.com' },
  },
};
```

Assertions:
- `canUse(config, {name:'ann@example.com'}, 'sales') === true` (case-insensitive)
- `canUse(config, {name:'bob@example.com'}, 'sales') === false`
- `canUse(config, {name:'bob@example.com', groups:['analysts']}, 'sales') === true`
- `canUse(config, {name:'bob@example.com', groups:['Analysts']}, 'sales') === false` (groups are compared exactly)
- `canUse(config, {name:'bob@example.com'}, 'open') === true`
- `canUse(config, {name:undefined, groups:undefined}, 'open') === true` and `... 'sales') === false`
- `canUse(config, {name:'ann@example.com'}, 'locked') === false`
- `canUse(config, {name:'root@example.com'}, 'locked') === true`, `{name:'IVAN'}` → true, `{name:'x', groups:['admins']}` → true
- `canUse(config, {name:'ann@example.com'}, 'broken') === false` and `canUse(config, {name:'ivan'}, 'broken') === true`
- `canUse(config, access.ALL, 'locked') === true`
- For each of `'__proto__'`, `'constructor'`, `'toString'`, `'nope'`: `canUse(config, access.ALL, id) === false`
- `Object.keys(visible(config, {name:'ann@example.com'}))` deep-equals `['open', 'sales']`
- `visible(config, {name:'ann@example.com'}).sales === config.db.sales`
- `problems(config)` has exactly 1 entry, and it mentions `broken`
- `problems({ superusers: 'ivan', db: {} })` has 1 entry mentioning `superusers`
- `problems({ db: {} })` deep-equals `[]`
- `fromSession(undefined)` deep-equals `{ name: undefined, groups: undefined }`

- [ ] **Step 2: Run it and check that it fails.** Run `node test/access.js`. Expected: it fails with `Cannot find module '../access.js'`.
- [ ] **Step 3: Implement `access.js`.** Use `Object.prototype.hasOwnProperty.call` for the id check. Lower-case only the non-`group:` entries and the name. A missing or non-array `who.groups` means no groups.
- [ ] **Step 4: Run `node test/access.js`.** Expected: all PASS.
- [ ] **Step 5: Add `access.js` to `test/run.js`, update `config.js.example` and `CLAUDE.md`, then run `node test/run.js`.** Expected: every suite passes.
- [ ] **Step 6: Commit.** `git add access.js test/access.js test/run.js config.js.example CLAUDE.md && git commit -m "feat: access.js, per-database allow lists and superusers"`

### Task 2: Web UI enforcement

**Files:**
- Modify: `start.js`: `prepare_dbconnection` (~line 400), and the startup config checks next to the `allowlist.problems` logging
- Modify: `requestHandlers.js`: `prepare_locals` (`databaseList`, ~line 45), `sqlHistory` (~979), `sqlDetails` (~994)
- Test: `test/oauth.js`, in `wiringSection`

**Interfaces:**
- Consumes: `access.canUse`, `access.visible`, `access.fromSession`, `access.problems` from Task 1.

- [ ] **Step 1: Write the failing tests.** In `wiringSection`'s config, add two databases using the same sqlite fixture file: `annsdb: { type: 'sqlite', database: dbFile, allow: ['ann@example.com'] }` and `hidden: { type: 'sqlite', database: dbFile, allow: ['bob@example.com'] }`. Also add `allow_clear_sql: true`, so the history routes exist. The spawned app runs with its cwd at the repo root, so point its SQL history at a test file: pass `SQLITE_PATH=<dir>/history.sqlite` in its environment (extend `spawnApp`'s `opts` with an `env` if it has none). Before spawning, create that file with `better-sqlite3`, using the `sql` table schema from `sqliteDB.js`, and insert one row with `dbid = 'hidden'`. POST `/hidden:sql` can't create the row, because that route is itself guarded. Signed in as ann (reuse `browserLogin`), assert:
  - `GET /`: the body contains `annsdb`, and does not contain `>hidden<`
  - `GET /annsdb`: 200
  - `GET /hidden` and `GET /hidden/items`: 404, and the body contains `No such database: hidden.`
  - `GET /:sql`: the body does not contain `hidden`
  - `GET /:sql/<id of the hidden row>`: 404
  - The spawned app's startup output contains no access warning.
- [ ] **Step 2: Run `node test/oauth.js`.** Expected: the new assertions FAIL, because `hidden` is listed and served.
- [ ] **Step 3: Implement.**
  - In `prepare_dbconnection`, treat `!access.canUse(config, access.fromSession(req.session), dbId)` exactly like the existing `!req.dbconfig` branch, with the same message and 404.
  - In `prepare_locals`, set `databaseList: access.visible(config, access.fromSession(req.session))`.
  - In `sqlHistory`, keep only rows whose `dbid` is a key of `res.locals.databaseList`.
  - In `sqlDetails`, when a row exists and its `dbid` is not a key of `res.locals.databaseList`, call `showError(req, res, 'No such query.', null, 404)`.
  - In `start.js`, log each `access.problems(config)` line at startup, the same way `allowlist.problems` lines are logged.
- [ ] **Step 4: Run `node test/oauth.js` and then `node test/run.js`.** Expected: all pass.
- [ ] **Step 5: Commit.** `git commit -am "feat: enforce per-database access in the web UI"`

### Task 3: MCP enforcement

**Files:**
- Modify: `oauth_provider.js`: `verifyAccessToken` (~line 196), so that `extra` is `{ email: row.email, groups: row.groups }`
- Modify: `mcp.js`: `register()` (~86), `dbEntry()` (~102), `checkIdentifiers` (~116), `withDb()` (~123), and every tool in `buildServer()`
- Test: `test/oauth.js`, in `mcpSection`

**Interfaces:**
- Consumes: `access.ALL`, `access.canUse`, `access.visible` from Task 1.
- Produces, internal to `mcp.js`:
  - `register()` calls `fn(args, who)`. `who` is `access.ALL` when `extra.authInfo` is absent (the static token). Otherwise it is `{ name: authInfo.extra.email, groups: authInfo.extra.groups }`.
  - `dbEntry(config, id, who)` throws `No such database: <id>` when `!access.canUse(config, who, id)`.
  - `checkIdentifiers` and `withDb` take `who` as one more argument and pass it on to `dbEntry`.

- [ ] **Step 1: Write the failing tests.** In `mcpSection`'s config:
  - Add `hidden: { type: 'sqlite', database: dbFile, allow: ['bob@example.com'] }` and `superusers: ['root@example.com']`.
  - Get a second OAuth token whose login email is `root@example.com`. The mock IdP takes per-login claims (see the header of `test/helpers/mock_oidc.js`); extend `oauthTokens()` with an optional email if it has no such parameter.
  - Assert:
    - Ann's token: `list_databases` ids do not include `hidden`. `list_tables {db:'hidden'}` returns `isError` with text `No such database: hidden`. `list_tables {db:'lite'}` still works.
    - Root's token: `list_databases` includes `hidden`, and `list_tables {db:'hidden'}` includes `items`.
    - The static token: `list_databases` includes `hidden`.
- [ ] **Step 2: Run `node test/oauth.js`.** Expected: the ann and `hidden` assertions FAIL.
- [ ] **Step 3: Implement the interfaces above.** `list_databases` maps over `Object.keys(access.visible(config, who))`. Every other tool passes `who` through `withDb`, `dbEntry` and `checkIdentifiers`.
- [ ] **Step 4: Run `node test/oauth.js`, then `node test/mcp.js`** (static-token paths: unchanged behaviour), then `node test/run.js`. Expected: all pass.
- [ ] **Step 5: Commit.** `git commit -am "feat: enforce per-database access over MCP"`

## Known gaps (accepted, documented in CLAUDE.md in Task 1)

- Routes that addons register themselves in `a.setup()` (the bundled `fun` addon registers none) bypass the check. Addon *features* run under `/:db_id/...` and are covered.
- `/ao/config` exposes addon config, not database config, and is unchanged.
