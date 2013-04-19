var config = require("./config");

// templating engine
var JUST = require('just');
var just_usecache = false; // or true
var just      = new JUST({ root: './view', useCache: just_usecache, ext: '.html' });
var justStyle = new JUST({ root: './view', useCache: just_usecache, ext: '.css' });
var justJS    = new JUST({ root: './view', useCache: just_usecache, ext: '.js' });

var mysql    = require('./db_mysql.js');
var postgres = require('./db_postgres.js');

var async = require('async');

var authenticate = false;
if (config.authenticate) {
    authenticate = true;
}

function login (response, pathname, errmsg) {
    if (!pathname) {
        pathname = '/';
    }
    just.render('login',{ errormsg: errmsg, path: pathname}, function(error, html) {
        showPage (response, error, html);
    });
}

function selectDatabase (response) {
    just.render('listDatabase', { databaseList: config.db, authenticate: authenticate}, function(error, html) {
        showPage (response, error, html);
    });
}

function start(response, connection, pathname, dbType, tableGroupsFile) {
    var tabGr = [];
    async.waterfall([
        function (done){
            readFile(tableGroupsFile, done);
        },

        function (tableGroups, done){
            getArrayOfStrings(tableGroups, done);
        },

        function (tableGroups, done){
            tabGr = tableGroups;
            var db = getDbType(dbType);
            db.showAllTable(connection, done);
        }

    ], function (err, result) {
        just.render('tableList', { tablesList: result, path: pathname, tableGr: tabGr, authenticate: authenticate }, function(error, html) {
            showPage (response, error, html);
        });
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
        var temp = /[^\n]+[\n\r]*/.exec(tableGroups);
        if (/\S/.exec(temp)) {
            array[i] = temp.join().replace(/\n|\r/g, '');
            i++;
        }
        tableGroups = tableGroups.replace(/[^\n]+[\n\r]*/, '');
    }

    done(null, array);
}

function showTable(response, connection, pathname, dbType, table_groups, table) {
    var db;
    async.waterfall([
        function (done){
            db = getDbType(dbType);
            db.showTableRequest(connection, table, done);
        }

    ], function (err, results) {
        var templatesP = {attrList: results[0], rowsCounter: results[1], indexesArr: results[2], foreignKey: results[3], referenced: results[4], triggers: results[5], statusArr: results[6]};

        if(dbType == 'mysql') {
            templatesP = {attrList: results[0], rowsCounter: results[1], indexesArr: results[2], statusArr: results[3]};
        }

        templatesP.path = pathname;
        templatesP.tableName = table;
        templatesP.dbType = dbType;
        templatesP.authenticate = authenticate;

        just.render('tableDetails', templatesP, function(error, html) {
            showPage (response, error, html);
        });
    });
}

function showColumn(response, connection, pathname, dbType, table_groups, table, column) {
    var limit = 20;
    var db;
    async.waterfall([
        function (done){
            db = getDbType(dbType);
            db.showColumnRequest(connection, column, table, limit, done);
        }

    ], function (err, results) {
        just.render('columnData', { columnData: results, authenticate: authenticate }, function(error, html) {
            showPage (response, error, html);
        });
    });
}

function showValue(response, connection, pathname, dbType, table_groups, table, column, value) {
    var limit = 10;
    var db;
    async.waterfall([
        function (done){
            db = getDbType(dbType);
            db.showValueRequest(connection, table, column, value, limit, done);
        }

    ], function (err, results) {
        if (results[1] > 0) {
            just.render('showValues', { values: results[0], rowsCount: results[1], authenticate: authenticate }, function(error, html) {
                showPage (response, error, html);
            });
        } else {
            showError(response, "The value '" + value + "' is not present in column '" + column + "'");
        }
    });
}

function getDbType (dbType) {
    var db = mysql;

    if (dbType == 'postgres') {
        db = postgres;
    }

    return db;
}

function showPage (response, error, html, type) {
    if (error) {
        console.log(error);
    }

    if (!type) {
        type = 'html';
    }

    response.writeHead(200, {"Content-Type": "text/" + type});
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
exports.login = login;
exports.showTable = showTable;
exports.cssConnect = cssConnect;
exports.showColumn = showColumn;
exports.showError = showError;
exports.selectDatabase = selectDatabase;
exports.showValue = showValue;