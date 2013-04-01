var config = require("./config");
var JUST = require('just');
var just = new JUST({ root : './view', useCache : true, ext : '.html' });
var justStyle = new JUST({ root : './view', useCache : true, ext : '.css' });
var mysql = require('./mysqlRequest.js');
var postgres = require('./postgresRequest.js');
var async = require('async');

function selectDatabase (response) {
    just.render('showDatabase', { databaseList: config.db }, function(error, html) {
        showPage (response, error, html);
    });
}

function start(response, connection, pathname, dbType, tableGroupsFile) {
    async.waterfall([
        function (done){
            readFile(tableGroupsFile, done);
        },

        function (tableGroups, done){
            getArrayOfStrings(tableGroups, done);
        }

    ], function (err, result) {
        var db = getDbType(dbType);
        db.showAllTable(response, connection, pathname, result);
    });
}

function readFile(fileName, done) {
    var fs = require('fs');

    if (fileName) {
        fs.open(fileName, "r+", 0644, function(err, file_handle) {
            if (!err) {
                // read 100 kilobytes from the beginning of the file in ascii
                fs.read(file_handle, 100000, null, 'ascii', function(err, data) {
                    if (!err) {
                        fs.close(file_handle);
                        done(null, data);
                    } else {
                        done(err, '');
                    }
                });
            } else {
                console.log('Can not read file ' + fileName);
                done(err, '');
            }
        });
    } else {
        console.log('File with groups of tables is absent in the file config.js');
        done(null, '');
    }
}

function getArrayOfStrings(tableGroups, done) {
    var array = [];
    var i = 0;

    while (/\S/.exec(tableGroups)) {
        var temp = /[^\n]+\n*/.exec(tableGroups);
        if (/\S/.exec(temp)) {
            array[i] = /\s*\S+/.exec(temp);
            i++;
        }
        tableGroups = tableGroups.replace(/[^\n]+\n*/, '');
    }

    done(null, array);
}

function showTable(response, connection, pathname, dbType) {
    var table = /([^\/]+)$/.exec(pathname)[0];
    var db = getDbType(dbType);
    db.showTableRequest(response, connection, pathname, table);
}

function showColumn(response, connection, pathname, dbType) {
    var column = /([^\/]+)$/.exec(pathname)[0];

    var pathnameTemp = pathname;
    pathnameTemp = pathnameTemp.replace(/(\/[^\/]+)$/, '');
    var table = /([^\/]+)$/.exec(pathnameTemp)[0];

    var limit = 20;

    var db = getDbType(dbType);
    db.showColumnRequest(response, connection, column, table, limit);
}

function getDbType (dbType) {
    var db = mysql;

    if (dbType == 'postgres') {
        db = postgres;
    }

    return db;
}

function showPage (response, error, html) {
    if (error) {
        console.log(error);
    }

    response.writeHead(200, {"Content-Type": "text/html"});
    response.write(html);
    response.end();
}

function showError (response, msg) {
    console.log(msg);
    response.writeHead(404, {"Content-Type": "text/html"});
    response.write("404 Status. " + msg);
    response.end();
}

function cssConnect (response) {
    justStyle.render('style', {}, function(error, html) {
        showPage (response, error, html);
    });
}

exports.start = start;
exports.showTable = showTable;
exports.cssConnect = cssConnect;
exports.showColumn = showColumn;
exports.showError = showError;
exports.showPage = showPage;
exports.selectDatabase = selectDatabase;