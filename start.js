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

// make req._pathname available everywhere 
app.use(prepare_pathname);

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

var connectionStatus = {};

var loginError = 'This login & password combination is not allowed.';

app.get('/', loadUser, function(req, res){ //run method selectDatabase
    requestHandlers.selectDatabase(res);
});

app.get('/style.css', function(req, res){ //connect to css file
    requestHandlers.cssConnect(res);
});

app.get('/main.js', function(req, res){ //connect to main.js file(login form)
    requestHandlers.mainConnect(res);
});

app.post(/^\/(\w+):sql\/*(\d)*/, loadUser, function(req, res){ //select to sqlite db
    var dbId = req.params[0];
    if (req.body.db) {
        dbId = req.body.db;
    }
    var sqlId = req.params[1];
    var comment = req.body.comment;
    if(comment == 'comment...'){
        comment = '';
    }

    if (req.body.sql) {
        if (req.body.run == 'Execute') {
            var path_breadcrumbs = '/' + dbId + '/:sql/' + sqlId + '/show';
            checkConnectShowPage(res, req, dbId, requestHandlers.sqlRequest, '', '', '', req.body.sql, req.body.name, req.session.user, comment, path_breadcrumbs, sqlId);
        }
        else if (req.body.run == 'Save'){
            requestHandlers.sqlSave(res, req.body.sql, req.body.name, comment, dbId, req.session.user, sqlId);
        }
        else if (req.body.run == 'Remove'){
            requestHandlers.sqlRemove(res, sqlId, dbId);
        }
        else {
            checkConnectShowPage(res, req, dbId, requestHandlers.sqlRequest, '', '', '', req.body.sql, req.body.name, req.session.user);
        }
    } else {
        if (req.body.run) {
            res.redirect('/:sql/' + sqlId);
        } else {
            res.redirect('/' + dbId);
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

app.get('/:dbID', loadUser, 
    prepare_dbconnection,
    requestHandlers.start
);

app.get('/:dbID/:table', loadUser, function(req, res){ //run method showTable
    checkConnectShowPage(res, req, req.params.dbID, requestHandlers.showTable, req.params.table);
});

app.get('/:dbID/:table/:column', loadUser, function(req, res){ //run method showColumn
    checkConnectShowPage(res, req, req.params.dbID, requestHandlers.showColumn, req.params.table, req.params.column);
});

app.get('/:dbID/:table/:column/:value', loadUser, function(req, res){ //run method showValue
    checkConnectShowPage(res, req, req.params.dbID, requestHandlers.showValue, req.params.table, req.params.column, req.params.value);
});

app.listen(config.listen.port, config.listen.host);
console.log("Server has started. Listening at http://" + config.listen.host + ":" + config.listen.port);

// two lines in checkConnectShowPage() did this
function prepare_pathname( req, res, next ) {
    var pathname = url.parse(req.url).pathname;
    req._pathname = pathname.replace(/\/$/, '');
    next();
}

// replacement for dbConnect()
function prepare_dbconnection( req, res, next ) {
    var dbId = req.params.dbID;
    req.dbconfig = config.db[dbId];

    var done = function (err) {
        if (err) {
            // handle the error
            requestHandlers.showError(req, res,
                "Error connecting to the database with id '" + dbId + "'. " + err );

        } else {
            // save connection into request
            req.dbconnection = connectionStatus[dbId].connection;
            // call next handler
            next();
        }
    };

    if (!req.dbconfig) {
        return requestHandlers.showError(req, res,
            "No such database: " + dbId + ".");
    }

    if (!connectionStatus[dbId]) {
        connectionStatus[dbId] = {
            status: false,
            connection: '',
        }
    }

    if (connectionStatus[dbId].status == true) {
        connectionStatus[dbId].connection.query("SELECT NOW()", function(err, rows, fields) {
            if (err) {
                // reconnect
                connectionStatus[dbId].status = false;
                db_connect(req, dbId, done);
            } else {
                return done();
            }
        });
    }

    if (connectionStatus[dbId].status == false) {
        db_connect(req, dbId, done);
    }
}


// replacement for makeConnect()
function db_connect( req, dbId, done ) {
    console.log("Connect to database " + dbId + " ...");
    var c = req.dbconfig;
    if (!c) {
        done( "The database with id '" +  dbId + "' is absent in the configuration" );
        return;
    }
    if (c.type == 'mysql') {
        connectionStatus[dbId].connection = mysql.createConnection({
            host     : c.host,
            user     : c.user,
            password : c.password,
            database : c.database,
        });

        connectionStatus[dbId].connection.connect(done);

    } else if (c.type == 'postgres') {
        var conString = "tcp://" + c.user + ":" + c.password + "@" + c.host + "/" + c.database;
        connectionStatus[dbId].connection = new pg.Client(conString);
        connectionStatus[dbId].connection.connect(done);

    } else {
        // unsupported db type
    }

}


function checkConnectShowPage(response, req, dbId, methodRun, table, column, value, sql, sqlName, user, comment, path_breadcrumbs, sqlId) {
    var pathname = url.parse(req.url).pathname;
    pathname = pathname.replace(/\/$/, '');

    async.waterfall([
        function (done){
            dbConnect(dbId, response, done, pathname);
        }

    ], function (err) {
        dataInput(err, dbId, methodRun, response, pathname, table, column, value, sql, sqlName, user, comment, path_breadcrumbs, sqlId);
    });
}

function dbConnect(dbId, response, done, pathname) {
    if (!connectionStatus[dbId]) {
        connectionStatus[dbId] = {
            status: false,
            connection: '',
        }
    }

    if (connectionStatus[dbId].status == true) {
        connectionStatus[dbId].connection.query("SELECT NOW();", function(err, rows, fields) {
            if (err) {
                connectionStatus[dbId].status = false;
                makeConnect (dbId, response, done, pathname);
            } else {
                done(null);
            }
        });
    }

    if (connectionStatus[dbId].status == false) {
        makeConnect (dbId, response, done, pathname);
    }
}

function dataInput(err, dbId, methodRun, response, pathname, table, column, value, sql, sqlName, user, comment, path_breadcrumbs, sqlId) {
    var table_groups = '';

    if (err) {
        connectionStatus[dbId].status = false;
        requestHandlers.showError(response, "Error connecting to the database with id '" + dbId + "'. " + err, pathname);
    } else {
        connectionStatus[dbId].status = true;
        if (config.db[dbId].table_groups) {
            table_groups = config.db[dbId].table_groups;
        }

        if (sql) {
            methodRun(response, connectionStatus[dbId].connection, config.db[dbId].type, sql, pathname, dbId, sqlName, user, comment, path_breadcrumbs, sqlId);
        } else {
            methodRun(response, connectionStatus[dbId].connection, pathname, config.db[dbId].type, table_groups, table, column, value);
        }
    }
}

function makeConnect (dbId, response, done, pathname) {
    console.log("Connect to database " + dbId + " ...");
    var c = config.db[dbId];
    if (!c) {
        requestHandlers.showError(response, "The database with id '" +  dbId + "' is absent in the configuration", pathname);
        return;
    }
    if (c.type == 'mysql') {
        connectionStatus[dbId].connection = mysql.createConnection({
            host     : c.host,
            user     : c.user,
            password : c.password,
            database : c.database,
        });

        connectionStatus[dbId].connection.connect(function(err) {
            done(err);
        });
    }
    else if (c.type == 'postgres') {
        var conString = "tcp://" + c.user + ":" + c.password + "@" + c.host + "/" + c.database;
        connectionStatus[dbId].connection = new pg.Client(conString);

        connectionStatus[dbId].connection.connect(function(err) {
            done(err);
        });
    } else {
        // unsupported db type
    }

}

function loadUser(req, res, next) {
    if (!config.authenticate) { return next(); }

    var pathname = url.parse(req.url).pathname;
    if ( /^\/(\w+):sql\/*(\d)*/.exec(pathname) ) {
        pathname = '/';
    }
    if (req.session.authentication) {
        next();
    } else {
        requestHandlers.login(res, pathname, '');
    }
}