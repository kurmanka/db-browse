// MCP (Model Context Protocol) interface: read-only database access for agents.
// Mounted at /mcp by start.js; see docs/superpowers/specs/2026-10-04-mcp-interface-design.md
//
// Streamable HTTP in stateless mode: every request gets a fresh server and
// transport, there are no MCP sessions. The tools hold no state.

'use strict';
var crypto     = require('crypto');
var bodyParser = require('body-parser');
var McpServer  = require('@modelcontextprotocol/sdk/server/mcp.js').McpServer;
var StreamableHTTPServerTransport =
        require('@modelcontextprotocol/sdk/server/streamableHttp.js').StreamableHTTPServerTransport;

var pkg = require('./package.json');
var z      = require('zod').z;
var mcp_db = require('./mcp_db.js');

var db_modules = {
    mysql   : require('./db_mysql.js'),
    postgres: require('./db_postgres.js'),
    sqlite  : require('./db_sqlite.js')
};

// getTableDetails() returns an unlabelled array whose order depends on the driver
var DETAIL_NAMES = {
    postgres: ['columns', 'indexes', 'status', 'referenced_by', 'triggers', 'foreign_keys'],
    mysql   : ['columns', 'create_table', 'details'],
    sqlite  : ['columns', 'create_sql']
};

var DEFAULT_MAX_ROWS = 1000;


function sha256(s) {
    return crypto.createHash('sha256').update(String(s)).digest();
}

// Authorization: Bearer <token>. Both sides are hashed first, so the compare is
// constant-time whatever the lengths.
function bearerAuth(token) {
    var expected = sha256(token);
    return function (req, res, next) {
        var m = /^Bearer (.+)$/i.exec(req.headers.authorization || '');
        if (m && crypto.timingSafeEqual(sha256(m[1]), expected)) {
            return next();
        }
        res.status(401).set('WWW-Authenticate', 'Bearer').json({ error: 'unauthorized' });
    };
}


function jsonReplacer(key, value) {
    return (typeof value === 'bigint') ? value.toString() : value;
}

function failure(err) {
    return { isError: true, content: [{ type: 'text', text: String((err && err.message) || err) }] };
}

// Registers a tool. fn(args) returns a JSON-serializable value, or throws /
// rejects; the latter becomes a tool error rather than an unhandled exception.
function register(server, name, description, shape, fn) {
    server.registerTool(name, { description: description, inputSchema: shape }, async function (args) {
        console.log('mcp %s %s', name, JSON.stringify(args || {}).slice(0, 200));
        try {
            var value = await fn(args || {});
            return { content: [{ type: 'text', text: JSON.stringify(value, jsonReplacer, 2) }] };
        } catch (e) {
            return failure(e);
        }
    });
}


// config.db[id], only for an id the config itself defines: the id is agent input,
// and inherited names ('constructor', '__proto__') must not resolve to anything
function dbEntry(config, id) {
    if (!Object.prototype.hasOwnProperty.call(config.db, id)) {
        throw new Error('No such database: ' + id);
    }
    return config.db[id];
}

// calls fn(dbModule, connection, done) with a read-only connection for config.db[dbId]
function withDb(config, dbId, fn) {
    var c = dbEntry(config, dbId);
    var mod = db_modules[c.type];
    if (!mod) { throw new Error("Unsupported database type '" + c.type + "'"); }

    return mcp_db.callDb(config, dbId, function (conn, done) {
        fn(mod, conn, done);
    });
}

// the cap protects the agent's context window; it does not bound server memory
function capRows(rows, max) {
    if (!Array.isArray(rows)) { return { rows: rows, truncated: false }; }
    return { row_count: rows.length, truncated: rows.length > max, rows: rows.slice(0, max) };
}


function buildServer(config) {
    var server = new McpServer({ name: 'db-browse', version: pkg.version });
    var maxRows = (config.mcp && config.mcp.max_rows) || DEFAULT_MAX_ROWS;
    var db = z.string().describe('database id, from list_databases');

    register(server, 'list_databases',
        'List the databases available through this server (id, type, comment). ' +
        'Use an id as the `db` argument of the other tools.',
        {},
        async function () {
            return Object.keys(config.db).map(function (id) {
                var c = config.db[id];
                return { id: id, type: c.type, comment: c.comment || null };
            });
        });

    register(server, 'list_tables',
        'List the tables of a database.',
        { db: db },
        function (a) {
            return withDb(config, a.db, function (mod, conn, done) { mod.showAllTable(conn, done); });
        });

    register(server, 'describe_table',
        'Describe a table: columns, and, depending on the database type, indexes, ' +
        'create statement, foreign keys, triggers and other details.',
        { db: db, table: z.string() },
        function (a) {
            var type = dbEntry(config, a.db).type;
            return withDb(config, a.db, function (mod, conn, done) {
                mod.getTableDetails(conn, a.table, done);
            }).then(function (parts) {
                var out = {};
                DETAIL_NAMES[type].forEach(function (name, i) { out[name] = parts[i]; });
                return out;
            });
        });

    register(server, 'count_rows',
        'Count the rows in a table.',
        { db: db, table: z.string() },
        function (a) {
            return withDb(config, a.db, function (mod, conn, done) {
                mod.rowsCounter(conn, a.table, done);
            }).then(function (n) { return { count: Number(n) }; });
        });

    register(server, 'column_values',
        'The most frequent values of a column with their row counts (GROUP BY, most frequent first).',
        { db: db, table: z.string(), column: z.string(),
          limit: z.number().int().min(1).max(maxRows).default(Math.min(50, maxRows)) },
        function (a) {
            return withDb(config, a.db, function (mod, conn, done) {
                mod.showColumnRequest(conn, a.column, a.table, a.limit, done);
            });
        });

    register(server, 'browse_rows',
        'Rows of a table, ordered by a column, optionally filtered by equality on columns. ' +
        'In `where`, the value NOTNULL means "is not null".',
        { db: db, table: z.string(),
          order_by: z.string().describe('column to order by (required)'),
          direction: z.enum(['ASC', 'DESC']).default('ASC'),
          limit: z.number().int().min(1).max(maxRows).default(Math.min(30, maxRows)),
          where: z.record(z.string(), z.string()).optional()
                  .describe('column -> required value; all must match') },
        function (a) {
            var order = { order_by: a.order_by, direction: a.direction, limit: a.limit };
            return withDb(config, a.db, function (mod, conn, done) {
                mod.showValueRequest(conn, a.table, a.where || {}, order, done);
            }).then(function (rows) { return capRows(rows, maxRows); });
        });

    if (config.allow_clear_sql) {
        register(server, 'query',
            'Run read-only SQL (in the database\'s own dialect). Writes fail. ' +
            'At most ' + maxRows + ' rows are returned; `truncated` says if there were more.',
            { db: db, sql: z.string() },
            function (a) {
                return withDb(config, a.db, function (mod, conn, done) {
                    mod.getSQL(conn, a.sql, done);
                }).then(function (rows) { return capRows(rows, maxRows); });
            });
    }

    return server;
}


// Returns true if mounted. Needs config.mcp.token; without it nothing is mounted.
function mount(app, config) {
    if (!config.mcp || !config.mcp.token) {
        return false;
    }

    var auth = bearerAuth(config.mcp.token);

    app.post('/mcp', auth, bodyParser.json(), async function (req, res) {
        var server = buildServer(config);
        var transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on('close', function () {
            transport.close();
            server.close();
        });
        try {
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
        } catch (e) {
            console.log('mcp error:', e);
            if (!res.headersSent) {
                res.status(500).json({ jsonrpc: '2.0', id: null,
                                       error: { code: -32603, message: 'Internal server error' } });
            }
        }
    });

    // stateless: no SSE stream (GET) and no session to end (DELETE)
    app.all('/mcp', auth, function (req, res) {
        res.status(405).set('Allow', 'POST').json({
            jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Method not allowed.' } });
    });

    return true;
}

exports.mount = mount;
