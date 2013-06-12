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
app.use(function(req, res, next){

  if(req.url == '/favicon.ico') {
      requestHandlers.showError(req, res, "Serve 404. Connect to /favicon.ico.");
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

app.get('/', prepare_req_params, 
             loadUser, 
             requestHandlers.prepare_locals,
             requestHandlers.selectDatabase); //run method selectDatabase

app.get('/style.css', requestHandlers.cssConnect); //connect to css file

app.post(/^\/(\w+):sql\/*(\d)*/, middleware, function(req, res){ //select to sqlite db
    // prepare_dbconnection() already sets req.params.dbID   
    //req.params.dbId = req.params[0];    
    if (req.body.db) {
        req.params.dbId = req.body.db;
    }

    req.params.sqlId = req.params[1];
    if(req.body.comment == 'comment...'){
        req.body.comment = '';
    }

    if (req.body.sql) {
        if (req.body.run == 'Execute') {
            req.params.path_breadcrumbs = '/' + req.params.dbId + '/:sql/' + req.params.sqlId + '/show';
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
            res.redirect('/:sql/' + req.params.sqlId);
        } else {
            res.redirect('/' + req.params.dbId);
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

app.get(/(\/\:sql)$/, loadUser, function(req, res){ //History of previous SQL
    requestHandlers.sqlHistory(res);
});

app.get(/\/\:sql\/\d+/, loadUser, function(req, res){ //Sql details page-form
    var pathname = url.parse(req.url).pathname;
    var sqlId = /(\d+)$/.exec(pathname);
    requestHandlers.sqlDetails(res, sqlId[0]);
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

app.get('/:dbID', middleware, requestHandlers.start); //run method start

app.get('/:dbID/:table', middleware, requestHandlers.showTable);//run method showTable

app.get('/:dbID/:table/:column', middleware, requestHandlers.showColumn); //run method showColumn

app.get('/:dbID/:table/:column/:value', middleware, requestHandlers.showValue); //run method showValue

app.listen(config.listen.port, config.listen.host);
console.log("Server has started. Listening at http://" + config.listen.host + ":" + config.listen.port);

function prepare_dbconnection( req, res, next ) {
    //console.log( 'prepare_dbconnection(): start' );
    if (!req.params.dbID) {
        req.params.dbID = req.body.db || req.params[0];
    }

    var dbId = req.params.dbID;
    req.dbconfig = config.db[dbId];

    if (!req.dbconfig) {
        return requestHandlers.showError(req, res,
                                         "No such database: " + dbId + ".");
    }

    // for compatibility
    req.params.dbType = req.dbconfig.type;

    if (req.dbconfig.table_groups) {
        req.params.groups = req.dbconfig.table_groups;
    }

    var done = function (err) {
        if (err) {
            // handle the error
            requestHandlers.showError(req, res,
                "Error connecting to the database with id '" + dbId + "'. " + err );

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