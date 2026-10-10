# 07 — Addon loading is broken for the bundled `fun` addon

**Severity:** low
**Area:** `addons/fun/index.js`, `start.js` — `init_addons`
**Found:** `/ao/config?ao=fun` returned 500; reading `init_addons`

## Symptoms

1. `addons/fun/index.js` does `var ECT = require('ect')` at module load. `ect` is
   neither in `package.json` nor in `node_modules`, so enabling the addon makes
   `init_addons` log `can't load addon ./addons/fun`.
2. `start.js:417` calls `a.init( app, config.addons.i, path )` — the literal
   property name `i` instead of `config.addons[i]`. Every addon's `init` receives
   `undefined` as its config.
3. The static-directory auth guard is installed inside a `for (var i ...)` loop:

       app.use( function (req, res, next) {
           if (req.url == prefix) { loadUser(req,res,next); } else next();
       } );

   `prefix` is the loop variable, so every guard (and every `app.use` path
   string, though those are evaluated eagerly) effectively sees the *last*
   addon's prefix. With more than one addon the auth gate is wrong.
4. `/ao/config?ao=fun` answers HTTP 500 with "ao param is empty or no such
   addon" for a well-formed request for a valid but disabled addon; it should be
   a 404, and it uses the deprecated `req.param()`.

## Fix

- Make the `ect` requirement lazy/tolerant in `addons/fun/index.js`: the addon
  loads without it, and only the `show` feature fails, with a clear message.
  Note `ect` as an optional requirement in the README/addon.
- Pass `config.addons[i]` to `init`.
- Build the static guard with a factory (or `let`) so each addon captures its own
  prefix.
- Return 404 for an unknown/absent addon and use `req.query.ao`.

## Verification

- `init_addons` with `exports.addons = { fun: {} }` logs `init addon fun` and
  does not crash without `ect`.
- `/ao/config?ao=nope` → 404; a configured addon still returns its config.

## Status

- [x] fixed

## What changed

- `addons/fun/index.js`: `ect` is required inside `init()`, not at module load.
  A missing engine is logged once and leaves `ect` null; `render()` then answers
  500 with a clear "run npm install ect" message instead of throwing. The
  add-on's SQL-template features work either way.
- `start.js` `init_addons`: `a.init(app, config.addons[i], path)` — the literal
  `config.addons.i` is gone.
- `start.js`: the static auth guard is built by `addon_static_guard(prefix)`, so
  each add-on captures its own prefix instead of whatever the shared loop
  variable held last.
- `start.js` `/ao/config`: uses `req.query.ao` (not the deprecated
  `req.param()`), answers **404** for a missing/unknown add-on, answers JSON, and
  checks `hasOwnProperty` so `?ao=constructor` cannot resolve to `Object`.
- `README.md` documents `ect` as an optional add-on requirement.

## Verification

- `test/drivers.js` requires `addons/fun/index.js` without `ect` installed and
  asserts it loads and that `render()` answers 500 with a helpful message rather
  than throwing.
- `test/routes.js` asserts `/ao/config` → 404 for no `ao`, an unknown add-on and
  `ao=constructor`.

The `config.addons[i]` and closure fixes were confirmed by inspection only: the
user's `config.js` has no add-ons enabled, and enabling one to test would mean
editing a file the project keeps out of the repository.

    $ node test/run.js
    7 / 20 / 16 / 62 passed, 0 failed
