var url   = require('url');
var async = require('async');
var mysql = require('mysql');
var pg    = require('pg');
var fs    = require('fs');
var express = require('express');

// some modules
var requestHandlers = require('./requestHandlers.js');
var sqlt = require('./sqlt.js');

// configuration
var config = require('./config.js');

// create the express app
var app = express();

if (0) {
    // enable if debugging is needed
    // https://github.com/devoidfury/express-debug
    app.configure('development', function() {
        var edt = require('express-debug');
        edt(app, {/* settings */});
    });
}

app.use(express.bodyParser());
app.use(express.cookieParser());

// very simple loging of the incomming requests to console
// from http://expressjs.com/api.html#app.use
// but don't log the damn /favicon.ico requests
// (which can be handled right away)
app.use(function(req, res, next){
    if(req.url == '/favicon.ico') {
        res.send(404,'Not found');
    } else {
        console.log('%s %s', req.method, req.url);
        next();
    }
});

// logging with response time
app.use(express.logger('tiny'));
// sessions
app.use(express.session(config.session_config));

app.use( '/_/', express.static('./static') );

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


app.post(/^\/(\w+):sql\/*(\d)*/, middleware, function(req, res){ //select to sqlite db
    req.params.sql_id = req.params[1];

    if (req.body.sql) {
        if (req.body.run == 'Execute') {
            req.params.path_breadcrumbs = '/' + req.params.db_id + '/:sql/'
                                             + req.params.sql_id + '/show';
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
                requestHandlers.readFile(config.authenticate_userfile, done1);
            },

            requestHandlers.getArrayOfStrings, // (text,done)

        ],  function (err, arr) {
            doneReturn( err, (arr.indexOf(search_string) != -1) );
        });
    }
}


// Login form's action attribute now points to /login
// while the 'to' parameter commands, where to redirect to
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

app.get(/(\/\:sql)$/, prepare_req_params, loadUser, requestHandlers.prepare_locals,
        requestHandlers.sqlHistory); //History of previous SQL

app.get(/\/\:sql\/\d+/, prepare_req_params, loadUser, requestHandlers.prepare_locals,
        requestHandlers.sqlDetails); //Sql details page-form

app.get('/logout', function(req, res){ //logout
    req.session.authentication = false;
    req.session.destroy(function(err){
        if(err) {
            console.log(err);
        }
    });
    res.redirect('/');
});

// former parameters_determination()
function prepare_req_params(req, res, next) {
    var pathname = url.parse(req.url).pathname;
    req.params.path = pathname.replace(/\/$/, '');

    var sqlId = /(\d+)$/.exec(pathname);
    if (sqlId) {
        req.params.sqlId = sqlId[0];
    }

    next();
}

app.get('/:db_id/.schema', middleware, requestHandlers.show_db_schema); //show db schema. Run show_db_schema.

app.get('/:db_id', middleware, requestHandlers.start); //run method start

app.get('/:db_id/:table',
        middleware,
        requestHandlers.showTable, // show table details, if that's a table
        addon_feature,             // run addon feature, if that's a feature
        requestHandlers.noSuchTable );

app.post('/:db_id/:table',
        middleware,
        addon_feature,             // run addon feature, if that's a feature
        requestHandlers.noSuchTable );

app.get('/:db_id/:table/:column', middleware, requestHandlers.showColumn); //run method showColumn

app.get('/:db_id/:table/:column/:value', middleware, requestHandlers.showValue); //run method showValue

app.listen(config.listen.port, config.listen.host);
console.log("Server has started. Listening at http://" + config.listen.host + ":" + config.listen.port);

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
                "Error connecting to the database with id '" + dbId + "'. " + err);

        } else {
            console.log('... connected');
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

    var pathname = req.params.path;
    if ( /^\/(\w+):sql\/*(\d)*/.exec(pathname) ) {
        pathname = '/';
    }
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
                    app.use('/ao/'+i, express.static(path+'/static'));
                    console.log( '/ao/' + i );
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
        req.app.addon_features[ feature ](req,res,next)

    } else {
        next();
    }

}
