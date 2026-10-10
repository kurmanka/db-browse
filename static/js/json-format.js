// Render the JSON values in .json table cells (views/inc/row_detail_value.pug)
// as a collapsible, syntax-highlighted tree, with a "raw" toggle that shows the
// original text for copying.
//
// The tree building is kept apart from the DOM work: buildTree() takes a value
// and returns a plain description, so it can be unit-tested in Node
// (test/drivers.js requires this file). No dependency, no CDN.

(function (root) {
    'use strict';

    var MAX_DEPTH = 3;    // containers deeper than this start collapsed
    var MAX_ITEMS = 20;   // containers with more entries than this start collapsed

    function kindOf(value) {
        if (value === null) { return 'null'; }
        if (Array.isArray(value)) { return 'array'; }
        if (typeof value === 'object') { return 'object'; }
        return typeof value;                       // string | number | boolean
    }

    function isContainer(kind) {
        return kind === 'object' || kind === 'array';
    }

    function summarize(value) {
        return Array.isArray(value) ? '[' + value.length + ']'
                                    : '{' + Object.keys(value).length + '}';
    }

    // value -> { kind, key, text | (summary, children, collapsed), comma }
    function buildTree(value, depth, key) {
        depth = depth || 0;

        var kind = kindOf(value);
        var node = { kind: kind, key: (key === undefined) ? null : String(key) };

        if (!isContainer(kind)) {
            node.text = (kind === 'string') ? JSON.stringify(value) : String(value);
            return node;
        }

        var keys = Object.keys(value);
        node.summary = summarize(value);
        node.collapsed = (depth >= MAX_DEPTH) || (keys.length > MAX_ITEMS);
        node.children = keys.map(function (k, i) {
            var child = buildTree(value[k], depth + 1, Array.isArray(value) ? i : k);
            child.comma = (i < keys.length - 1);
            return child;
        });

        return node;
    }

    // ---- DOM rendering ----

    function span(cls, text) {
        var s = document.createElement('span');
        if (cls) { s.className = cls; }
        s.textContent = text;
        return s;
    }

    function renderNode(node) {
        var row = document.createElement('div');
        row.className = 'j-row';

        if (node.key !== null) {
            row.appendChild(span('j-key', node.key));
            row.appendChild(document.createTextNode(': '));
        }

        if (!isContainer(node.kind)) {
            row.appendChild(span('j-' + node.kind, node.text));
            if (node.comma) { row.appendChild(span('j-comma', ',')); }
            return row;
        }

        var open  = (node.kind === 'array') ? '[' : '{';
        var close = (node.kind === 'array') ? ']' : '}';

        var head = document.createElement('div');
        head.className = 'j-head';
        var toggle = span('j-toggle', '');
        head.appendChild(toggle);
        head.appendChild(span('j-bracket', open));
        head.appendChild(span('j-summary', node.summary));
        head.appendChild(span('j-bracket', close));
        if (node.comma) { head.appendChild(span('j-comma', ',')); }

        var body = document.createElement('div');
        body.className = 'j-body';
        node.children.forEach(function (child) { body.appendChild(renderNode(child)); });

        var box = document.createElement('div');
        box.className = 'j-node';
        box.appendChild(head);
        box.appendChild(body);

        var collapsed = node.collapsed;
        function apply() {
            box.classList.toggle('j-collapsed', collapsed);
            box.classList.toggle('j-open', !collapsed);
            toggle.textContent = collapsed ? '\u25B8' : '\u25BE';
        }
        head.addEventListener('click', function () { collapsed = !collapsed; apply(); });
        apply();

        row.appendChild(box);
        return row;
    }

    function renderCell(cell) {
        var text = cell.textContent;
        var value;
        try { value = JSON.parse(text); } catch (e) { return; }   // not JSON: leave it

        var tree = renderNode(buildTree(value, 0));

        var raw = document.createElement('pre');
        raw.className = 'j-raw';
        raw.hidden = true;
        raw.textContent = text;

        var toggle = document.createElement('a');
        toggle.href = '#';
        toggle.className = 'j-rawtoggle';
        toggle.textContent = 'raw';
        toggle.addEventListener('click', function (ev) {
            ev.preventDefault();
            raw.hidden = !raw.hidden;
            tree.hidden = !raw.hidden;
            toggle.textContent = raw.hidden ? 'raw' : 'tree';
        });

        var bar = document.createElement('div');
        bar.className = 'j-bar';
        bar.appendChild(toggle);

        cell.textContent = '';
        cell.classList.add('json-parsed');
        cell.appendChild(bar);
        cell.appendChild(tree);
        cell.appendChild(raw);
    }

    function init() {
        var cells = document.querySelectorAll('td.json');
        for (var i = 0; i < cells.length; i++) {
            // a cell showing the compact short form (static/js/row-compact.js)
            // is not an expanded value yet: it gets its tree when clicked
            if (cells[i].classList.contains('compact-preview')) { continue; }
            renderCell(cells[i]);
        }
    }

    var api = { buildTree: buildTree, renderCell: renderCell,
                MAX_DEPTH: MAX_DEPTH, MAX_ITEMS: MAX_ITEMS };

    root.jsonFormat = api;
    if (typeof module !== 'undefined' && module.exports) { module.exports = api; }

    if (typeof document !== 'undefined') {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', init);
        } else {
            init();
        }
    }

})(typeof window !== 'undefined' ? window : this);
