// Compact ("short values") mode for the row views (issue 17).
//
// The row views print every value in full, so one long text or JSON column makes
// a page of records scroll forever. With compact mode on, each such cell shows
// only the start of its value and a click expands that one cell in place: plain
// text as it is, a JSON value as the tree from static/js/json-format.js. The
// switch lives in the fixed header (views/row_detail_wrapper.pug) and the choice
// is kept in a cookie, which views/requestHandlers.js also reads so the first
// paint already agrees with it.
//
// The DOM work needs the browser; the pure helpers are exported for the unit
// tests (test/drivers.js). No dependency, no CDN.

(function (root) {
    'use strict';

    var COOKIE = 'dbb_compact';
    var DEFAULT_LIMIT = 80;
    var ELLIPSIS = '\u2026';

    // ---- pure helpers ----

    // What to show for a long text value: runs of whitespace (newlines
    // included) become one space, so the short form is a single scannable line.
    // null when the value already fits and there is nothing to shorten.
    function previewText (text, limit) {
        var flat = String(text === null || text === undefined ? '' : text)
                       .replace(/\s+/g, ' ').trim();
        if (!flat || flat.length <= limit) { return null; }
        return flat.slice(0, limit).replace(/\s+$/, '') + ELLIPSIS;
    }

    // A JSON cell is always shown as its start in compact mode, so this returns
    // a string even when the value is short. The preview comes from the compact
    // serialisation, not from the pretty-printed block the server sent, so it
    // stays one line.
    function previewJson (text, limit) {
        var source = text;
        try { source = JSON.stringify(JSON.parse(text)); } catch (e) { /* leave it */ }
        var flat = String(source).replace(/\s+/g, ' ').trim();
        if (!flat) { return null; }
        return (flat.length <= limit)
             ? flat
             : flat.slice(0, limit).replace(/\s+$/, '') + ELLIPSIS;
    }

    // The cookie records the switch. Compact mode is on unless it says '0'
    // (the same default as compactOn() in requestHandlers.js).
    function compactCookie (on) {
        return COOKIE + '=' + (on ? '1' : '0')
             + ';path=/;max-age=31536000;SameSite=Lax';
    }

    // ---- DOM ----

    var limit = DEFAULT_LIMIT;
    var active = false;

    function eachCell (fn) {
        var cells = document.querySelectorAll('td.data');
        for (var i = 0; i < cells.length; i++) { fn(cells[i]); }
    }

    function isJsonCell (cell) {
        return cell.classList.contains('json');
    }

    function remember (cell) {
        if (cell.__fullText === undefined) { cell.__fullText = cell.textContent; }
    }

    // Cells that hold more than a bare value - a link to a related record, the
    // referring-records list, an already-built JSON tree - are left alone:
    // rewriting them as text would throw markup away.
    function clampable (cell) {
        if (cell.classList.contains('null')) { return false; }
        if (isJsonCell(cell)) { return cell.__fullText !== undefined; }
        if (cell.children.length > 0) { return false; }
        return true;
    }

    // Show the short form. Returns false when there is nothing to shorten.
    function clampCell (cell) {
        if (!clampable(cell)) { return false; }
        var preview = isJsonCell(cell) ? previewJson(cell.__fullText, limit)
                                       : previewText(cell.__fullText, limit);
        if (preview === null) { return false; }

        cell.textContent = preview;
        cell.classList.add('compact-preview');
        cell.classList.remove('compact-open');
        cell.setAttribute('title', 'Click for the whole value');
        return true;
    }

    // Show the whole value: text as it is, JSON as its tree (issue 12).
    function expandCell (cell) {
        if (!cell.classList.contains('compact-preview')) { return; }

        cell.textContent = cell.__fullText;
        cell.classList.remove('compact-preview');
        cell.classList.add('compact-open');
        cell.removeAttribute('title');

        if (isJsonCell(cell) && root.jsonFormat) {
            root.jsonFormat.renderCell(cell);
            addShortLink(cell);
        }
    }

    // Put a cell back the way the page rendered it (used when the switch is
    // turned off, which also folds every individually expanded cell).
    function restoreCell (cell) {
        if (cell.__fullText === undefined) { return; }
        var touched = cell.classList.contains('compact-preview')
                   || cell.classList.contains('compact-open');
        cell.classList.remove('compact-preview', 'compact-open');
        cell.removeAttribute('title');
        if (!touched) { return; }

        cell.textContent = cell.__fullText;
        if (isJsonCell(cell) && root.jsonFormat) { root.jsonFormat.renderCell(cell); }
    }

    function apply (state, initial) {
        active = state;
        eachCell(function (cell) {
            remember(cell);
            if (!state) {
                // On the first pass json-format.js has not run yet and builds
                // the trees itself; restoring here would only do it twice.
                if (!initial) { restoreCell(cell); }
                return;
            }
            clampCell(cell);
        });
    }

    // The tree's own bar carries a "raw" link back to the original text; in
    // compact mode it also gets a way back to the short form.
    function addShortLink (cell) {
        var bar = cell.querySelector('.j-bar');
        if (!bar || bar.querySelector('.j-short')) { return; }

        var a = document.createElement('a');
        a.href = '#';
        a.className = 'j-short';
        a.textContent = 'short';
        a.addEventListener('click', function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
            clampCell(cell);
        });

        bar.appendChild(document.createTextNode(' \u00b7 '));
        bar.appendChild(a);
    }

    function cellOf (node) {
        while (node && node.nodeType !== 9) {          // 9 is the document
            if (node.nodeType === 1 && node.tagName === 'TD') { return node; }
            node = node.parentNode;
        }
        return null;
    }

    function onClick (ev) {
        if (!active) { return; }

        var cell = cellOf(ev.target);
        if (!cell) { return; }
        if (ev.target.closest && ev.target.closest('a')) { return; }   // a link, not a toggle

        if (cell.classList.contains('compact-preview')) {
            expandCell(cell);
            ev.preventDefault();
        } else if (cell.classList.contains('compact-open') && !isJsonCell(cell)) {
            // a JSON cell folds with its own markers and the "short" link
            clampCell(cell);
            ev.preventDefault();
        }
    }

    function init () {
        var box = document.getElementById('compact');
        if (!box) { return; }                 // config.compact_chars is 0

        limit = parseInt(box.getAttribute('data-limit'), 10) || DEFAULT_LIMIT;
        box.parentNode.removeAttribute('hidden');

        box.addEventListener('change', function () {
            active = box.checked;
            // a browser refusing cookies must still get the switch for this page
            try { document.cookie = compactCookie(active); } catch (e) { /* ignore */ }
            apply(active, false);
        });

        document.addEventListener('click', onClick);

        active = box.checked;                 // rendered by the server from the cookie
        apply(active, true);
    }

    var api = {
        previewText:   previewText,
        previewJson:   previewJson,
        compactCookie: compactCookie,
        COOKIE:        COOKIE,
        DEFAULT_LIMIT: DEFAULT_LIMIT
    };

    root.rowCompact = api;
    if (typeof module !== 'undefined' && module.exports) { module.exports = api; }

    if (typeof document !== 'undefined') {
        // This script is at the end of the body, below the table, so the cells
        // are already parsed. Remembering them here - before json-format.js
        // replaces a JSON cell with its tree - is what keeps the original text
        // available for the short form.
        eachCell(remember);

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', init);
        } else {
            init();
        }
    }

})(typeof window !== 'undefined' ? window : this);
