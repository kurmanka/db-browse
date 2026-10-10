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

- [ ] fixed
