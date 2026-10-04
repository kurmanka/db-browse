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


function buildServer(config) {
    var server = new McpServer({ name: 'db-browse', version: pkg.version });

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
