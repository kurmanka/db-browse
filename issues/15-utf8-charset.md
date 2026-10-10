# 15 — Non-ASCII characters were mangled on the table-details page

**Severity:** medium (visible corruption on a main page)
**Area:** `views/page.pug`, `requestHandlers.js` (`showPageTotalRecords`)
**Found:** reported after the Pug port (issue 09); it is a regression from it

## Symptom

The table-details page showed mojibake in the browser:

    Table user_account â€” 100 records
    user_id  integer  not null default nextval(...)  â¤´ Â·â¤µ

`â€”` is a UTF-8 em dash (E2 80 94) read as Windows-1252, `â¤´` is `⤴`
(E2 A4 B4) and `Â·` is `·` (C2 B7) — the classic "UTF-8 decoded as latin-1".

Only *some* pages were affected, which is the clue.

## Evidence

    GET /                       -> Content-Type: text/html; charset=utf-8
    GET /notes2                 -> Content-Type: text/html; charset=utf-8
    GET /notes2/notes/domain/_ASC -> Content-Type: text/html; charset=utf-8
    GET /notes2/meta            -> Content-Type: text/html          <-- no charset
    GET /submittal1/user_account -> Content-Type: text/html         <-- no charset

The body itself was correct UTF-8 all along:

    $ curl ... /notes2/meta | grep -o '⤴' | xxd
    00000000: e2a4 b40a                                ....

and the page carried no charset declaration at all:

    $ curl ... /notes2/meta | grep -io '<meta[^>]*charset[^>]*>'
    (nothing)

## Root cause

Two independent halves:

1. `showPageTotalRecords()` writes the page itself:

       res.writeHead(200, {"Content-Type": "text/html"});

   `writeHead` overrides the header Express would have set, and a bare
   `text/html` leaves the encoding unspecified, so the browser guesses
   (Windows-1252 on this machine). Every other page goes through
   `res.send(html)`, which Express sends as `text/html; charset=utf-8` — hence
   "some pages".

2. The Pug port (issue 09) dropped the charset declaration the legacy layout
   had. `view/parent.html` began with

       <meta http-equiv="Content-Type" content="text/html; charset=UTF-8">

   and `views/page.pug`, written to replace it, did not carry it over. The meta
   tag is the backstop that makes the page correct whatever the header says.

## Fix

- `views/page.pug`: `meta(charset="utf-8")` as the first element in `<head>`,
  restoring what the legacy layout declared.
- `requestHandlers.js`: the table-details response is written as
  `text/html; charset=utf-8`.

Both are needed: the header covers everything the server sends, and the meta
covers the page wherever it ends up.

## Verification

    GET /notes2/meta             -> Content-Type: text/html; charset=utf-8
    GET /submittal1/user_account -> Content-Type: text/html; charset=utf-8
    <meta charset="utf-8"/>
    ⤴ · — present; no "â¤´"/"â€”"/"Â·"

`test/routes.js` now asserts, for the table-details page, that the
`Content-Type` carries the charset, that the page declares it, and that the sort
arrow (`\u2934`) and the em dash (`\u2014`) survive.

## Also fixed: the missing doctype

`views/page.pug` started with `html`, not `doctype html`, so browsers rendered
the app in **quirks mode** (the legacy templates had the same omission, so this
was not a regression). It now starts with `doctype html`, which also makes Pug
emit HTML5 void tags — `<meta charset="utf-8">`, not `<meta charset="utf-8"/>`.

This was deferred at first because standards mode can move layout, so it needed a
visual check. Chrome was available after all, and `--headless=new --screenshot`
renders the real pages saved from the server.

Two things about running it on this machine, both learned the hard way:

- Point the profile somewhere writable (`--user-data-dir=/tmp/…`) and add
  `--disable-crash-reporter --crash-dumps-dir=/tmp/…`, or the sandbox turns its
  writes to `~/Library` into permission errors.
- Add **`--use-mock-keychain`**. Do *not* "fix" the sandbox by pointing `HOME`
  at a temp directory: Chrome then looks for
  `$HOME/Library/Keychains/login.keychain-db`, finds nothing, and macOS pops a
  *"Keychain Not Found — A keychain cannot be found to store "Chrome.""* dialog
  on every launch. That dialog's "Reset To Defaults" button resets the keychain
  search list, so it is not something to leave on screen for a user to click.

With those flags it renders quietly:

| Page | compat mode before | after | pixel diff |
|---|---|---|---|
| `/submittal1/user_account` (table details) | `BackCompat` | `CSS1Compat` | 0 of 1,260,000 |
| `/submittal1/user_account/user_id/_ASC/hor/3` (row view) | `BackCompat` | `CSS1Compat` | 0 of 1,260,000 |

`document.compatMode` was read back from each file with `--dump-dom`, so the mode
really did change: the identical rendering is a result, not a setup that ignored
the doctype. The same pages were also rendered with the missing doctype inserted
back, and stayed identical.

Two notes on the screenshots: they cover the sort arrows and the fixed
header/footer, which is the visual check [issue 11](11-fixed-page-layout.md) had
been missing, and the JSON tree, which is the one [issue 12](12-json-support.md)
had been missing. The record count does not appear in them because a `file://`
page cannot load the jQuery CDN script; that is an artefact of the harness, not
of the app.

Five more pages were compared the same way (each page rendered twice, once as
served and once with the doctype removed, so the doctype was the only variable):
`/` (database list), `/submittal1` (table list), `/:sql` (SQL history), `/nope`
(error page) and a vertical row view. Four were pixel-identical; the table list
differed by 0.71% of its pixels, all in one place: in quirks mode the user
agent's stylesheet left a gap under the SQL form's "Execute it" button, and in
standards mode it did not.

That gap is now explicit rather than inherited from a UA quirk:

    #sql_request button { margin-bottom: 0.8em; }

and the re-rendered page looks right.

## Test-harness side note

While verifying this, the suite could not run: the app is served by pm2 on port
1888, and issue 01's guard correctly refuses to test a foreign process. The
harness now asks the OS for a free port when the configured one is taken
(`DBB_TEST_PORT` pins one), spawns its own server there via `DBB_PORT`, and
still refuses to test anything it did not start.

## Status

- [x] fixed
