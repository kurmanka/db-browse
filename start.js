var url   = require('url');
var async = require('async');
var mysql = require('mysql2');
var pg    = require('pg');
var db_sqlite = require('./db_sqlite.js');
var fs    = require('fs');
var express       = require('express')
, morgan          = require('morgan')
, serve_static    = require('serve-static')
, express_session = require('express-session')
, bodyParser      = require('body-parser')
, cookieParser    = require('cookie-parser')
;

// https://nodejs.org/docs/latest-v8.x/api/string_decoder.html
const { StringDecoder } = require('string_decoder');
const decoder = new StringDecoder('utf8');


// some modules
var requestHandlers = require('./requestHandlers.js');
var sqlt = require('./sqlt.js');
var util = require('./util.js');
var mcp = require('./mcp.js');
var auth_store = require('./auth_store.js');
var allowlist = require('./allowlist.js');
var access    = require('./access.js');
var oidc_mod = require('./oidc.js');
var oauth_provider = require('./oauth_provider.js');

// configuration: ./config.js, or the file named by DBB_CONFIG
var config = require(util.configPath());

// Tests (and confined environments) may not be able to write to the session
// store directory named in config.js. DBB_SESSION_MEMORY=1 falls back to
// express-session's in-memory store: correct for a short-lived test process,
// never for a real deployment (sessions are lost on restart and leak memory).
if (process.env.DBB_SESSION_MEMORY) {
    delete config.session_config.store;
}

// A configuration the app cannot run safely with stops it here, before it
// listens.
function startup_error(msg) {
    console.error('Configuration error: ' + msg);
    process.exit(1);
}

// config.mcp.oauth.public_url is the OAuth issuer, and the SDK serves the
// OAuth endpoints and metadata at the root of it: it must be a bare origin.
function public_url_problem(v) {
    if (typeof v !== 'string' || !v) { return 'is missing'; }
    var u;
    try { u = new URL(v); } catch (e) { return 'is not a URL'; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') { return 'must be an http(s) URL'; }
    if (u.pathname !== '/' || v.indexOf('?') >= 0 || v.indexOf('#') >= 0 || u.username || u.password) {
        return 'must be an origin such as https://dbb.example.com (no path, query or fragment)';
    }
    return null;
}

if (config.mcp && config.mcp.oauth) {
    if (!config.oidc) {
        startup_error('config.mcp.oauth needs config.oidc: MCP logins go through the OIDC provider');
    }
    var pub_problem = public_url_problem(config.mcp.oauth.public_url);
    if (pub_problem) { startup_error('config.mcp.oauth.public_url ' + pub_problem); }
}
allowlist.problems(config).forEach(function (msg) {
    console.log('Warning: ' + msg);
});
access.problems(config).forEach(function (msg) {
    console.log('Warning: ' + msg);
});

// OIDC web login, and the OAuth authorization server for MCP clients on top
// of it. Both off (null) without config.oidc / config.mcp.oauth.
var auth_db  = config.oidc ? auth_store.open(config.auth_db || 'auth.sqlite') : null;
var oidc     = oidc_mod.create(config, auth_db);
var provider = (oidc && config.mcp && config.mcp.oauth)
             ? oauth_provider.create(config, auth_db, oidc) : null;

// create the express app
var app = express();
var server; // .listen() returns that

// Response headers for every page: no framing by other sites (a click on a
// page shown in their frame could be stolen), no content-type guessing, and
// no full URLs (they hold table names and row values) in Referer headers to
// other sites.
app.use(function (req, res, next) {
    res.set({
        'X-Frame-Options':         'DENY',
        'Content-Security-Policy': "frame-ancestors 'none'",
        'X-Content-Type-Options':  'nosniff',
        'Referrer-Policy':         'same-origin'
    });
    next();
});

// Behind a reverse proxy, req.ip (and so the per-client rate limits on the
// OAuth endpoints) needs this; see the 'trust proxy' setting in the Express docs.
if (config.trust_proxy !== undefined) {
    app.set('trust proxy', config.trust_proxy);
}

if (0) {
    // enable if debugging is needed
    // https://github.com/devoidfury/express-debug
    app.configure('development', function() {
        var edt = require('express-debug');
        edt(app, {/* settings */});
    });
}

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(cookieParser());

// The query of /oidc/callback carries the identity provider's authorization
// code: the request logs below leave it out.
function loggable_url(url) {
    return /^\/oidc\/callback/i.test(url) ? url.replace(/\?.*$/, '?...') : url;
}

// very simple loging of the incomming requests to console
// from http://expressjs.com/api.html#app.use
// but don't log the damn /favicon.ico requests
// (which can be handled right away)
app.use(function(req, res, next){
    if(req.url == '/favicon.ico') {
        res.status(404).send('Not found');
    } else {
        console.log('%s %s', req.method, loggable_url(req.url));
        next();
    }
});

// logging with response time: morgan's 'tiny' format, with the URL as above
morgan.token('loggable-url', function (req) {
    return loggable_url(req.originalUrl || req.url);
});
app.use(morgan(':method :loggable-url :status :res[content-length] - :response-time ms'));

// MCP interface (a no-op unless config.mcp.token or config.mcp.oauth is set),
// with the OAuth endpoints when there is a provider. It has to come before
// the session middleware, or every agent request would create a session file.
try {
    mcp.mount(app, config, provider || undefined);
} catch (e) {
    startup_error(e.message);
}

// Cross-site request forgery. Everything below is the browser UI, where a
// POST runs SQL or logs someone in, so a POST another site made the browser
// send is refused. Browsers say where a request comes from in Sec-Fetch-Site:
// 'same-origin', or 'none' when the user did it directly, is fine. A browser
// that sends no such header is covered by the SameSite cookie below. (MCP and
// the OAuth endpoints, mounted above, take tokens, not cookies.)
app.use(function refuse_cross_site_posts(req, res, next) {
    var site = req.get('sec-fetch-site');
    if (req.method !== 'POST' || !site || site === 'same-origin' || site === 'none') {
        return next();
    }
    res.status(403).type('text/plain').send('Cross-site request refused.');
});

// sessions. SameSite=Lax unless config.js says otherwise: a browser then
// leaves the session cookie off POSTs from other sites.
config.session_config.cookie = Object.assign({ sameSite: 'lax' }, config.session_config.cookie);
if (config.session_config.secret === 'real sessions secret') {
    console.log('Warning: session_config.secret is the example value from config.js.example; ' +
                'set your own (for example: openssl rand -hex 32)');
}
app.use(express_session(config.session_config));

// OIDC: GET /login, /oidc/login and /oidc/callback. After the session
// middleware: a web login is bound to the browser's session.
if (oidc) {
    oidc.mountWeb(app, { mcp: provider ? provider.complete : undefined });
}
// The MCP client consent page (oauth_provider.js complete()) posts here.
if (provider) {
    app.post(oauth_provider.CONSENT_PATH, provider.consent);
}

app.use( '/_/', serve_static('./static') );

// Pug templates live in the views/ directory; views/page.pug is the shared
// layout and every other page extends it.
app.set('views', __dirname + '/views');

app.engine('pug', require('pug').__express)

var database = {};

var loginError = 'This login & password combination is not allowed.';

var middleware = [  prepare_req_params,
                    loadUser,
                    prepare_dbconnection,
                    requestHandlers.prepare_locals ];

init_addons( app, config );

app.get('/', prepare_req_params,
             loadUser,
             requestHandlers.prepare_locals,
             requestHandlers.selectDatabase); //run method selectDatabase


app.post(/^\/([\w\d]+):sql\/*(\d*)/, 
    function (req,res,n) {
        // the following is not needed, 
        // because prepare_req_params() does it for us
        //req.params.db_id  = req.params[0];
        // but this is needed:
        req.params.sql_id = req.params[1];
        n();
    },
    middleware, 
    function(req,res){ //select to sqlite db

        if (!config.allow_clear_sql) {
            return res.status(404).send('not found');
        }

        console.dir(req.body);

        if (req.body.sql) {
          requestHandlers.sqlRowAllowed(req, res, function () {
            if (req.body.run == 'Save'){
                requestHandlers.sqlSave(req, res);
            }
            else if (req.body.run == 'Remove'){
                requestHandlers.sqlRemove(req, res);
            }
            else {  // 'Execute', or no button at all
                own_connection(req, res, function () {
                    requestHandlers.sqlRequest(req, res);
                });
            }
          });
        } else {
            if (req.body.run) {
                res.redirect('/:sql/' + req.params.sql_id);
            } else {
                res.redirect('/' + req.params.db_id);
            }
        }
});


// handle the authenticate_userfile config setting

if ( config.authenticate_userfile && !config.authenticate ) {
    config.authenticate = function (name, password, doneReturn) {
        var search_string = name + ':' + password;

        async.waterfall([
            function (done1){
                // https://nodejs.org/docs/latest-v8.x/api/fs.html#fs_fs_readfile_path_options_callback
                fs.readFile(config.authenticate_userfile, done1);
            },
            function (buffer, done) {
                done(null, decoder.write(buffer));
            },
            util.getArrayOfStrings, // (text,done)

        ],  function (err, arr) {
            if (err) {console.log (err); }
            else doneReturn( err, (arr.indexOf(search_string) != -1) );
        });
    }
}


// Password guessing: after LOGIN_MAX_FAILURES failed logins for one user name
// from one address within LOGIN_WINDOW_MS, further attempts are refused until
// the window has passed. Behind a reverse proxy, set config.trust_proxy, or
// every client has the proxy's address and the limit is per user name only.
var LOGIN_MAX_FAILURES = 10;
var LOGIN_WINDOW_MS    = 15 * 60 * 1000;
var login_failures = new Map();     // 'ip|name' -> { count, since }

function login_key(req) {
    return req.ip + '|' + String(req.body.user || '').toLowerCase();
}

function login_blocked(key) {
    var now = Date.now();
    login_failures.forEach(function (f, k) {
        if (now - f.since > LOGIN_WINDOW_MS) { login_failures.delete(k); }
    });
    var f = login_failures.get(key);
    return !!(f && f.count >= LOGIN_MAX_FAILURES);
}

function login_failed(key) {
    var f = login_failures.get(key);
    if (f) { f.count++; } else { login_failures.set(key, { count: 1, since: Date.now() }); }
}

// Login form's action attribute now points to /login
// while the 'to' parameter tells us, where to redirect to
// in case of success.
// With OIDC on there is no password login at all: the users.txt check must
// not become a way around the allowlist.
if (!oidc) app.post('/login', function(req, res) { //get and check users data

    var key = login_key(req);
    if (login_blocked(key)) {
        res.status(429);
        return requestHandlers.login(req, res, 'Too many failed logins. Try again later.');
    }

    async.waterfall([
        function (done){
            config.authenticate(req.body.user, req.body.pass, done);
        }
    ],  function (err, result) {
            if (err) {
                return requestHandlers.showError(req, res, err);
            }

            if (result) {
                console.log( 'authenticated successfully' );
                login_failures.delete(key);

                // a local path only (no other site), '/' for '/login' or none
                var to = oidc_mod.safeLocal(req.body.to || req.query.to);

                // a fresh session id on login (no session fixation)
                req.session.regenerate(function (err) {
                    if (err) { return requestHandlers.showError(req, res, err); }
                    req.session.authentication = true;
                    req.session.user = req.body.user;
                    res.redirect( to );
                    console.log( 'redirecting to ', to );
                });

            } else {
                login_failed(key);
                requestHandlers.login(req, res, loginError);
            }
        }
    );
});


function set_sql_id (req,res,n) {
    if (req.params[0]) {
        req.params.sql_id = req.params[0];
    }
    n();
}

var sql_middleware = [prepare_req_params, set_sql_id, loadUser, requestHandlers.prepare_locals];

app.get(/\/\:sql$/, sql_middleware, requestHandlers.sqlHistory); //History of previous SQL

app.get(/\/\:sql\/(\d+)$/, sql_middleware, requestHandlers.sqlDetails); //Sql details page-form

app.get('/logout', function(req, res){ //logout
    req.session.authentication = false;
    req.session.destroy(function(err){
        if(err) {
            console.log(err);
        }
    });
    res.redirect('/');
});

app.get('/:db_id/.schema', middleware, requestHandlers.show_db_schema); //show db schema. Run show_db_schema.

app.get('/:db_id', middleware, requestHandlers.list_tables); // list tables

app.get('/:db_id/:table',
        middleware,
        requestHandlers.table_details, // show table details, if that's a table
        addon_feature,                 // run addon feature, if that's a feature
        requestHandlers.noSuchTable );

app.post('/:db_id/:table',
        middleware,
        addon_feature,             // run addon feature, if that's a feature
        requestHandlers.noSuchTable );

app.get('/:db_id/:table/:column', middleware, requestHandlers.showColumn); //run method showColumn

// /submittal/user_account/user_id/_ASC
// /submittal/user_account/user_id/_DESC/hor/55
app.get('/:db_id/:table/:column/_:direction/:view?/:limit?', middleware, requestHandlers.show_rows); 

// fetch & show a single table row or a bunch of them
//app.get('/:db_id/:table/:column/:value', middleware, requestHandlers.showValue); 
app.get('/:db_id/:table/:column/:value/:view?/:limit?', middleware, requestHandlers.show_rows); 


// Last: errors no route handled. Express's default handler would send the
// stack trace (unless NODE_ENV=production); log it here and answer with the
// status text only.
app.use(function (err, req, res, next) {
    console.log(err);
    if (res.headersSent) { return next(err); }
    var status = err.status || err.statusCode;
    if (!(status >= 400 && status < 600)) { status = 500; }
    res.status(status).type('text/plain').send(require('http').STATUS_CODES[status] || 'Error');
});

// DBB_PORT lets a caller (the test suite, or a second instance for a
// comparison) listen somewhere other than the port in config.js.
var listen_port = process.env.DBB_PORT || config.listen.port;

server = app.listen(listen_port, config.listen.host);

// Without a handler, a listen error (EADDRINUSE above all) is an unhandled
// 'error' event: the process dies with a stack trace. Say what happened
// instead, and exit non-zero.
server.on('error', function (err) {
    console.error("Cannot listen on http://" + config.listen.host + ":" + listen_port + ": " + err.message);
    process.exit(1);
});

// Announce readiness only once the socket is really bound: printing this next
// to app.listen() above was a lie (the bind happens later), and scripts that
// waited for this line would go on to talk to somebody else's server.
server.on('listening', function () {
    console.log("Server has started. Listening at http://" + config.listen.host + ":" + listen_port);
});


// make req.params.path
function prepare_req_params(req, res, next) {
    var pathname = url.parse(req.url).pathname;
    req.params.path = pathname.replace(/\/$/, '');

    next();
}



function prepare_dbconnection( req, res, next ) {
    //console.log( 'prepare_dbconnection(): start' );
    if (!req.params.db_id) {
        req.params.db_id = req.body.db || req.params[0];
    }
    var dbId = req.params.db_id;
    req.dbconfig = config.db[dbId];

    if (!req.dbconfig || !access.canUse(config, access.fromSession(req.session), dbId)) {
        // unknown or not permitted id (the same answer for both): not found, not a server error
        return requestHandlers.showError(req, res,
                                         "No such database: " + dbId + ".", null, 404);
    }

    // for compatibility
    req.params.dbType = req.dbconfig.type;

    if (req.dbconfig.table_groups) {
        req.params.groups = req.dbconfig.table_groups || '';
    }

    var done = function (err) {
        if (err) {
            // The database is configured but unreachable: that is a server-side
            // fault, distinct from an unknown id (404, above).
            requestHandlers.showError(req, res,
                "Error connecting to the database '" + dbId + "'. " + err, null, 502);
            delete database[dbId];

        } else {
            // save connection into request
            req.params.connect = req.dbconnection = database[dbId];
            // call next handler
            next();
        }
    };


    if (database[dbId]) {
        var pingSql = (req.dbconfig.type == 'sqlite') ? 'SELECT 1' : 'SELECT NOW()';
        database[dbId].query(pingSql, function(err, rows, fields) {
            if (err) {
                // reconnect
                database[dbId] = false;
                db_connect(req, dbId, done);
            } else {
                return done();
            }
        });
    } else {
        db_connect(req, dbId, done);
    }
}

function db_connect( req, dbId, done ) {
    var c = req.dbconfig;
    if (!c) {
        done( "The database with id '" +  dbId + "' is absent in the configuration" );
        return;
    }

    console.log( 'connecting to database ' + dbId );
    database[dbId] = new_connection(c);
    database[dbId].connect(done);
}

// A new, not yet connected connection for a config.db entry.
function new_connection( c ) {
    var cc = {
        host    : c.host,
        user    : c.user,
        password: c.password,
        database: c.database,
        port    : c.port
    };

    if (c.type == 'mysql') {
        return mysql.createConnection(cc);
    } else if (c.type == 'postgres') {
        return new pg.Client(cc);
    } else if (c.type == 'sqlite') {
        return db_sqlite.createConnection(cc);
    }
    // unsupported db type
    // XXX configuration error
}

// Raw SQL runs on a connection of its own, closed once the response is done,
// never on the shared one in `database`: whatever a statement changes in its
// session (SET, PRAGMA, temporary tables, an open transaction) must not reach
// other users' requests.
function own_connection( req, res, next ) {
    var conn = new_connection(req.dbconfig);
    var closed = false;
    function close() {
        if (closed) { return; }
        closed = true;
        conn.end(function () {});
    }
    // an error event without a listener would end the process
    if (conn.on) {
        conn.on('error', function (err) { console.log('raw SQL connection: ' + err); });
    }
    conn.connect(function (err) {
        if (err) {
            close();
            return requestHandlers.showError(req, res,
                "Error connecting to the database '" + req.params.db_id + "'. " + err, null, 502);
        }
        res.locals.connection = req.params.connect = req.dbconnection = conn;
        res.on('close', close);
        next();
    });
}

function loadUser(req, res, next) {
    if (oidc) {
        // GET /login (oidc.js) checks `to` and starts the provider login.
        // Only an OIDC login counts: a session left by the password login
        // (before OIDC was switched on) has not passed the allowlist.
        if (req.session.authentication && req.session.auth_via === 'oidc') { return next(); }
        return res.redirect('/login?to=' + encodeURIComponent(req.originalUrl));
    }

    if (!config.authenticate) { return next(); }

    if (req.session.authentication) {
        next();
    } else {
        requestHandlers.login(req, res, '');
    }
}

function init_addons (app, config) {
    if (!config.addons) { return; }

    // for each config.addons.*
    // do require('./addons/*/index.js')
    //
    app.addons = {};
    app.addon_features = {};

    for ( var i in config.addons ) {
        var path = './addons/' + i;
        try {
            var a = require(path + '/index.js');
        } catch (err) {
            console.log( "can't load addon " + path );
            console.log( err );
            continue;
        }

        if (a) {
            console.log( 'init addon ' + i );
            a.init( app, config.addons[i], path );
            app.addons[i] = a;
        }

        try {
            var s = fs.statSync( path+'/static' );
            if (s) {
                if (s.isDirectory()) {
                    // make the directory available, but only to signed-in users
                    var prefix = '/ao/' + i + '/';
                    // every file in it, not just the addon homepage.
                    // The guard is built per addon: a closure made in the loop
                    // would see the last addon's prefix for every addon.
                    app.use( addon_static_guard(prefix) );
                    app.use( prefix, express.static(path+'/static'));
                    console.log( prefix + i );
                    console.log( ' -> ' + path + '/static' );
                }
            }
        } catch (e) {
            console.log( e );
        }

        if (a.setup) {
            a.setup(app, config, path);
        }

        if ( a.features ) {
            for ( var f in a.features ) {
                app.addon_features[f] = a.features[f];
                // detect feature name conflicts? XXX
            }
        }

        if ( a.sqlt ) {
            for ( var f in a.sqlt ) {
                app.addon_features[f] = create_sqlt_feature( a.sqlt[f] );
                // detect feature name conflicts? XXX
            }
        }

    }

    app.get('/ao/config', loadUser, function (req, res) {
        var ao = req.query.ao;
        // hasOwnProperty: 'constructor' and friends must not resolve
        if (ao && Object.prototype.hasOwnProperty.call(config.addons, ao)) {
            res.json( config.addons[ao] );
        } else {
            res.status(404).send('ao param is empty or no such addon');
        }
    });
}

// The auth guard for one addon's static root. A factory, so each addon gets its
// own prefix even though the loop that installs these shares a scope.
function addon_static_guard (prefix) {
    return function (req, res, next) {
        // case-insensitive, as Express's own path matching is
        if (req.path.toLowerCase().indexOf(prefix.toLowerCase()) === 0) { loadUser(req, res, next); }
        else { next(); }
    };
}

function create_sqlt_feature( def ) {
    return function( req, res, n ) {
        sqlt.run_sqlt( def, req, res, n );
    };
}


function addon_feature (req,res,next) {
    console.log( 'addon_feature: start');

    var feature = req.params.table;
    // own keys only: 'constructor' and friends are not features. And there is
    // no feature map at all without config.addons.
    var features = req.app.addon_features;
    if (features && Object.prototype.hasOwnProperty.call(features, feature)) {
        //
        console.log( 'feature ' + feature );
        req.app.addon_features[ feature ](req,res);

    } else {
        next();
    }

}
