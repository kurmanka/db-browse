# 01 — `test/routes.js` can pass against a stale server

**Severity:** high (test integrity — a green run does not prove the code boots)
**Area:** `test/routes.js`, `start.js`
**Found:** exploring; reproduced directly

## Symptom

`node test/routes.js` reports PASS even when the server it spawns dies immediately,
as long as *some* server is already listening on port 1888. The suite then tests
that other server, which may be running older code. It printed

    Port 1888 already in use — stop the running server first

nowhere, because the promise had already resolved.

## Evidence

`startServer()` resolves as soon as the child writes "Server has started" to
stdout. `start.js` prints that string immediately after `app.listen(...)` returns,
*before* the socket is known to be bound, so the `EADDRINUSE` failure happens
afterwards. Reproduced with a direct spawn:

    $ node -e '... spawn("node", ["start.js"]) ...'
    STDOUT triggered resolve BEFORE bind error
    child exited code 1 signal null
    stderr: node:events:497  throw er; // Unhandled 'error' event

The child crashes on an unhandled `EADDRINUSE`; the test's `reject()` is a no-op
because the promise already resolved, and `stopServer()` kills an already-dead
child.

## Root cause

- `test/routes.js:84-95` — resolves on a stdout string, not on a bound port.
- `start.js:291-292` — logs "Server has started" before the port is known free.
- No `server.on('error')` handler in `start.js`, so `EADDRINUSE` produces an
  unhandled-error stack trace and exit code 1.

## Fix

1. `start.js`: attach `server.on('error')`; on `EADDRINUSE` print one clear line
   and exit non-zero instead of crashing with a stack trace.
2. `test/routes.js`:
   - refuse to start if something already answers on the port ("stop the running
     server first"), so the suite can never test a foreign process;
   - resolve only once the child is actually accepting connections (poll the
     port), not on a stdout line;
   - reject if the child exits before that happens.

## Verification

- Running the suite with a stray server on 1888 must fail fast with a clear
  message, not pass.
- Running it normally must still pass against its own child.

## Status

- [x] fixed

## What changed

- `start.js`: `server.on('error')` handles listen failures (one clear line, exit
  non-zero — no stack trace), and "Server has started" moved into
  `server.on('listening')`, so the readiness line is now true.
- `test/routes.js`: refuses to run when the port already answers, resolves only
  once the child is actually accepting connections, and fails if the child exits
  first (with its output attached).
- `test/routes.js`: spawns the server with `DBB_SESSION_MEMORY=1`, and `start.js`
  honours it by dropping the configured session store, so the test no longer
  writes into the user's session directory (which a sandbox may forbid, and which
  a test should not touch anyway).

## Verification

    $ node start.js            # with a server already running
    Cannot listen on http://localhost:1888: listen EADDRINUSE: address already in use ::1:1888
    exit: 1

    $ node test/routes.js      # with a server already running
    Could not start server: Port 1888 is already in use; refusing to test a foreign process. Stop the running server first.
    exit: 1

    $ node test/run.js         # clean
    7 passed, 0 failed / 9 passed, 0 failed / 62 passed, 0 failed
    exit: 0
