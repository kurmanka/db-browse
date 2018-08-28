var url   = require('url');
var async = require('async');
var mysql = require('mysql');
var pg    = require('pg');
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

// configuration
var config = require('./config.js');

// create the express app
var app = express();
var server; // .listen() returns that

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

// very simple loging of the incomming requests to console
// from http://expressjs.com/api.html#app.use
// but don't log the damn /favicon.ico requests
// (which can be handled right away)
app.use(function(req, res, next){
    if(req.url == '/favicon.ico') {
        res.status(404).send('Not found');
    } else {
        console.log('%s %s', req.method, req.url);
        next();
    }
});

// logging with response time
app.use(morgan('tiny'));
// sessions
app.use(express_session(config.session_config));

app.use( '/_/', serve_static('./static') );

// this is for Jade templates, they are in the views/ directory.
// while the view/ directory holds Just templates (see 
// requestHandlers.js for details).
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


app.post(/^\/(\w+):sql\/*(\d)*/, 
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

        if (req.body.sql) {
            if (req.body.run == 'Execute') {
                requestHandlers.sqlRequest(req, res);
            }
            else if (req.body.run == 'Save'){
                requestHandlers.sqlSave(req, res);
            }
            else if (req.body.run == 'Remove'){
                requestHandlers.sqlRemove(req, res);
            }
            else {
                requestHandlers.sqlRequest(req, res);
            }
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


// Login form's action attribute now points to /login
// while the 'to' parameter tells us, where to redirect to
// in case of success.
app.post('/login', function(req, res) { //get and check users data

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
                req.session.authentication = true;
                req.session.user = req.body.user;

                var to = req.param('to');

                // if the 'to' var is '/login' or is empty, set it to '/'
                if ( to == '/login' || !to ) {
                    to = '/';
                }
                res.redirect( to );
                console.log( 'redirecting to ', to );

            } else {
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

// Action /_exit
//
// This action was supposed to stop the current server process,
// to have it close all open database connections and re-read the 
// configuration.
//
// It assumes that some other facility would start another copy of
// the process if is needed. 
//
// For some reason on crunch server it doesn't really work for 
// closing database connections. Maybe it is because of the forever.js,
// which is responsible for server restart. 

app.get('/_exit', loadUser, function (req,res) {
    res.send('ok');
    
    // no exit gracefully, 
    // http://stackoverflow.com/questions/5263716/graceful-shutdown-of-a-node-js-http-server
    
    // this check it to avoid circular exits. I'm not sure this is useful.
    if (process.uptime() > 0.05) {
        console.log( "close server...\n" );
        server.close();
    }
});

// Action /_reset
//
// call database_connection.end() for each connected database;
// go through the database array elements, close connection on
// each of them.

app.get('/_reset', loadUser, function (req,res) {
    for (var id in database) {
        var db = database[id];
        if (db) {
            db.end();
        }
    }
    database = {};
    res.redirect('/'); 
    res.send('reset done')
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

// fetch & show a single table row or a bunch of them
//app.get('/:db_id/:table/:column/:value', middleware, requestHandlers.showValue); 
app.get('/:db_id/:table/:column/:value/:view?/:limit?', middleware, requestHandlers.show_rows); 


server = app.listen(config.listen.port, config.listen.host);
console.log("Server has started. Listening at http://" + config.listen.host + ":" + config.listen.port);


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

    if (!req.dbconfig) {
        return requestHandlers.showError(req, res,
                                         "No such database: " + dbId + ".");
    }

    // for compatibility
    req.params.dbType = req.dbconfig.type;

    if (req.dbconfig.table_groups) {
        req.params.groups = req.dbconfig.table_groups || '';
    }

    var done = function (err) {
        if (err) {
            // handle the error
            requestHandlers.showError(req, res,
                "Error connecting to the database '" + dbId + "'. " + err);
            delete database[dbId];

        } else {
            // save connection into request
            req.params.connect = req.dbconnection = database[dbId];
            // call next handler
            next();
        }
    };


    if (database[dbId]) {
        database[dbId].query("SELECT NOW()", function(err, rows, fields) {
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

    var cc = {
        host    : c.host,
        user    : c.user,
        password: c.password,
        database: c.database,
        port    : c.port
    };
    console.log( 'connecting to database ' + dbId );

    if (c.type == 'mysql') {
        database[dbId] = mysql.createConnection(cc);
    } else if (c.type == 'postgres') {
        database[dbId] = new pg.Client(cc);
    } else {
        // unsupported db type
        // XXX configuration error
    }
    database[dbId].connect(done);
}

function loadUser(req, res, next) {
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
            a.init( app, config.addons.i, path );
            app.addons[i] = a;
        }

        try {
            var s = fs.statSync( path+'/static' );
            if (s) {
                if (s.isDirectory()) {
                    // make the directory available, but only to signed-in users
                    var prefix = '/ao/' + i + '/';
                    // request authentication on the addon homepage
                    app.use( function (req, res, next) {
                        if (req.url == prefix) { loadUser(req,res,next); } 
                        else next(); 
                    } );
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

    app.get('/ao/config', loadUser, function(req,res) {
        var ao = req.param('ao')
        if ( ao && config.addons[ao] ) {
            res.send( config.addons[ao] );
        } else {
            res.send( 500, 'ao param is empty or no such addon' );
        }
    });
}

function create_sqlt_feature( def ) {
    return function( req, res, n ) {
        sqlt.run_sqlt( def, req, res, n );
    };
}


function addon_feature (req,res,next) {
    console.log( 'addon_feature: start');

    var feature = req.params.table;
    if (req.app.addon_features[ feature ]) {
        //
        console.log( 'feature ' + feature );
        req.app.addon_features[ feature ](req,res);

    } else {
        next();
    }

}
