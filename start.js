var requestHandlers = require("./requestHandlers");
var config = require("./config");

var url = require("url");
var async = require('async');
var mysql = require('mysql');
var pg = require('pg');
var fs = require("fs");

var express = require("express");
var app = express();

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

app.get('/style.css', requestHandlers.cssConnect); //connect to css file

app.post(/^\/(\w+):sql\/*(\d)*/, middleware, function(req, res){ //select to sqlite db
    req.params.sql_id = req.params[1];

    if (req.body.sql) {
        if (req.body.run == 'Execute') {
            req.params.path_breadcrumbs = '/' + req.params.db_id + '/:sql/' + req.params.sql_id + '/show';
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

app.post('/*', function(req, res){ //get and check users data
    var pathname = url.parse(req.url).pathname;
    var result = config.authenticate(req.body.user, req.body.pass);
    if (result == false) {
        requestHandlers.login(res, pathname, loginError);
    } else {
        req.session.authentication = true;
        req.session.user = req.body.user;

        if (pathname) {
            res.redirect(pathname);
        } else {
            res.redirect('/');
        }
    }
});

app.get(/(\/\:sql)$/, prepare_req_params, loadUser, requestHandlers.prepare_locals, function(req, res){ //History of previous SQL
    requestHandlers.sqlHistory(req, res);
});

app.get(/\/\:sql\/\d+/, prepare_req_params, loadUser, requestHandlers.prepare_locals, function(req, res){ //Sql details page-form
    var pathname = url.parse(req.url).pathname;
    var sqlId = /(\d+)$/.exec(pathname);
    requestHandlers.sqlDetails(req, res, sqlId[0]);
});

app.get('/logout', function(req, res){ //logout
    req.session.authentication = false;
    req.session.destroy(function(err){
        if(err) {
            console.log(err);
        }
   });
   requestHandlers.login(res, "/", '');
});

// former parameters_determination()
function prepare_req_params(req, res, next) {
    var pathname = url.parse(req.url).pathname;
    req.params.path = pathname.replace(/\/$/, '');

    next();
}

app.get('/:db_id', middleware, requestHandlers.start); //run method start

app.get('/:db_id/:table', 
        middleware, 
        requestHandlers.showTable, // show table details, if that's a table
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
        requestHandlers.login(res, pathname, '');
    }
}

function init_addons (app, config) {
    if (!config.addons) { return; }

    // for each config.addons.* 
    // do require('./addons/*/index.js')
    // 
    app.addons = {};

    for ( var i in config.addons ) {
        var path = './addons/' + i;
        try {
            var a = require(path + '/index.js');
        } catch (err) {
            console.log( "can't init addon " + i);
            continue;
        }

        if (a) {
            console.log( 'init addon ' + i );
            a.init( app, config.addons.i, path );
            app.addons[i] = a;
        }

        var s = fs.statSync( path+'/static' );
        if (s) {
            if (s.isDirectory()) {
                app.use('/ao/'+i, express.static(path+'/static'));
                console.log( '/ao/' + i );
                console.log( ' -> ' + path + '/static' );
            }
        }

        a.setup(app,config, path);

        app.addon_features = {};
        for ( var f in a.features ) {
            app.addon_features[f] = a.features.f;
            // detect feature name conflicts? XXX
        }

    }

}

function addon_feature (req,res,next) {

    var feature = req.params.table;
    if (req.app.addon_features[ feature ]) {
        // 
        console.log( 'feature ' + feature );
        req.app.addon_features[ feature ](req,res,next)

    } else {
        next();
    }

}
