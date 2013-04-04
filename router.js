var async = require('async');
var config = require("./config");
var mysql = require('mysql');
var pg = require('pg');

var connectionStatus = {};

function route(handle, pathname, response, request) {
    var checker = urlChecker(pathname);
    var table_groups = '';

    if (typeof handle[pathname] === 'function') {
        handle[pathname](response);
    }

    else if ( pathname.search("\.(css)$") != -1 ) {
        handle["cssConnect"](response);
    }

    else if ( checker == 1 ) {
        var dbId = pathname.replace(/\//g, '');
        checkConnectShowPage(dbId, handle, response, pathname, "start");
    }

    else if ( checker == 2 ) {
        var dbId = /[^\/]+/.exec(pathname)[0];
        checkConnectShowPage(dbId, handle, response, pathname, "showTable");
    }

    else if ( checker == 3 ) {
        var dbId = /[^\/]+/.exec(pathname)[0];
        checkConnectShowPage(dbId, handle, response, pathname, "showColumn");
    }

    else {
        handle["showError"](response, "No request handler found for " + pathname);
    }
}

function urlChecker(pathnameTemp) {
    var counter = 0;

    while ( /\/[^\/]+/.exec(pathnameTemp) ) {
        counter++;
        pathnameTemp = pathnameTemp.replace(/\/[^\/]+/, '');
    }

    return counter;
}

function dbConnect(dbId, handle, response, done) {
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
                makeConnect (dbId, handle, response, done);
            } else {
                done(null);
            }
        });
        console.log('!! ' + connectionStatus[dbId].status);
    }

    if (connectionStatus[dbId].status == false) {
        makeConnect (dbId, handle, response, done);
    }
}

function makeConnect (dbId, handle, response, done) {
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
        handle["showError"](response, "The database with id '" +  dbId + "' is absent in the configuration");
    }
}

function dataInput(err, dbId, handle, handleKey, response, pathname) {
    var table_groups = '';

    if (err) {
        connectionStatus[dbId].status = false;
        handle["showError"](response, "Error connecting to the database with id '" + dbId + "'. " + err);
    } else {
        connectionStatus[dbId].status = true;
        if (config.db[dbId].table_groups) {
            table_groups = config.db[dbId].table_groups;
        }
        handle[handleKey](response, connectionStatus[dbId].connection, pathname, config.db[dbId].type, table_groups);
    }
}

function checkConnectShowPage(dbId, handle, response, pathname, handleKey) {
    async.waterfall([
        function (done){
            dbConnect(dbId, handle, response, done);
        }

    ], function (err) {
        dataInput(err, dbId, handle, handleKey, response, pathname);
    });
}

exports.route = route;