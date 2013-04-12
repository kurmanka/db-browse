var requestHandlers = require("./requestHandlers");
var config = require("./config");

var http = require("http");
var url = require("url");
var async = require('async');
var mysql = require('mysql');
var pg = require('pg');
var express = require("express");
var app = express();

app.use(express.bodyParser());
app.use(express.cookieParser());
app.use(express.session({ secret: "keyboard cat" }));

var connectionStatus = {};

var loginError = 'This login & password combination is not allowed.';
var cooki_name = 'browse_db_login';

http.createServer();

app.get('/', function(req, res){ //run method selectDatabase
    checkAuthentication(requestHandlers.selectDatabase, req, res);
});

app.get('/style.css', function(req, res){ //connect to css file
    requestHandlers.cssConnect(res);
});

app.get('/main.js', function(req, res){ //connect to main.js file(login form)
    requestHandlers.mainConnect(res);
});

app.post('/*', function(req, res){ //get and check users data
    var pathname = url.parse(req.url).pathname;
    var result = config.authenticate(req.body.user, req.body.pass);
    if (result == false) {
        requestHandlers.login(res, pathname, loginError);
    } else {
        req.session.user = req.body.user;
        req.session.authentication = true;
        //var sid = req.sessionID;

        if (pathname) {
            res.redirect(pathname);
        } else {
            res.redirect('/');
        }
    }
});

app.get('/logout', function(req, res){ //logout
    res.clearCookie(cooki_name);
    req.session.authentication = false;
    req.session.destroy(function(err){
        if(err) {
            console.log(err);
        }
   });
   requestHandlers.login(res, "/", '');
});

app.get('/:dbID', function(req, res){ //run method start
    var pathname = url.parse(req.url).pathname;
    checkAuthentication(checkConnectShowPage, req, res, req.params.dbID, pathname, requestHandlers.start);
});

app.get('/:dbID/:table', function(req, res){ //run method showTable
    var pathname = url.parse(req.url).pathname;
    checkAuthentication(checkConnectShowPage, req, res, req.params.dbID, pathname, requestHandlers.showTable, req.params.table);
});

app.get('/:dbID/:table/:column', function(req, res){ //run method showColumn
    var pathname = url.parse(req.url).pathname;
    checkAuthentication(checkConnectShowPage, req, res, req.params.dbID, pathname, requestHandlers.showColumn, req.params.table, req.params.column)
});

app.listen(config.listen.port, config.listen.host);
console.log("Server has started. Listening at http://" + config.listen.host + ":" + config.listen.port);

function checkConnectShowPage(response, dbId, pathname, methodRun, table, column) {
    async.waterfall([
        function (done){
            dbConnect(dbId, response, done);
        }

    ], function (err) {
        dataInput(err, dbId, methodRun, response, pathname, table, column);
    });
}

function dbConnect(dbId, response, done) {
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
                makeConnect (dbId, response, done);
            } else {
                done(null);
            }
        });
    }

    if (connectionStatus[dbId].status == false) {
        makeConnect (dbId, response, done);
    }
}

function dataInput(err, dbId, methodRun, response, pathname, table, column) {
    var table_groups = '';

    if (err) {
        connectionStatus[dbId].status = false;
        requestHandlers.showError(response, "Error connecting to the database with id '" + dbId + "'. " + err);
    } else {
        connectionStatus[dbId].status = true;
        if (config.db[dbId].table_groups) {
            table_groups = config.db[dbId].table_groups;
        }
        methodRun(response, connectionStatus[dbId].connection, pathname, config.db[dbId].type, table_groups, table, column);
    }
}

function makeConnect (dbId, response, done) {
    console.log("Connect to database " + dbId + "..");

    if (config.db[dbId] && config.db[dbId].type == 'mysql') {
        connectionStatus[dbId].connection = mysql.createConnection({
            host     : config.db[dbId].host,
            user     : config.db[dbId].user,
            password : config.db[dbId].password,
            database : config.db[dbId].database,
        });

        connectionStatus[dbId].connection.connect(function(err) {
            done(err);
        });
    }

    else if (config.db[dbId] && config.db[dbId].type == 'postgres') {
        var conString = "tcp://postgres:" + config.db[dbId].password + "@" + config.db[dbId].host + "/" + config.db[dbId].database;
        connectionStatus[dbId].connection = new pg.Client(conString);

        connectionStatus[dbId].connection.connect(function(err) {
            done(err);
        });
    }

    else {
        requestHandlers.showError(response, "The database with id '" +  dbId + "' is absent in the configuration");
    }
}

function checkAuthentication(method, req, res, dbID, pathname, methodPageShow, table, column) {
    if ( config.authenticate && !req.session.authentication ) {
        requestHandlers.login(res, pathname, '');
    } else {
        method(res, dbID, pathname, methodPageShow, table, column);
    }
}