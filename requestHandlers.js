var config = require("./config");

// templating engine
var JUST = require('just');
var just_usecache = false; // or true
var just      = new JUST({ root: './view', useCache: just_usecache, ext: '.html' });
var justStyle = new JUST({ root: './view', useCache: just_usecache, ext: '.css' });
var justJS    = new JUST({ root: './view', useCache: just_usecache, ext: '.js' });

var mysql    = require('./db_mysql.js');
var postgres = require('./db_postgres.js');
var sqlite = require('./sqliteDB.js');

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
        if (err) {
            showError (response, err, pathname);
        } else {
            just.render('tableList', { tablesList: result, path: pathname, tableGr: tabGr, authenticate: authenticate, path_sql: pathname + ":sql"}, function(error, html) {
                showPage (response, error, html);
            });
        }
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
        if (err) {
            showError (response, err, pathname);
        } else {
            var templatesP = {attrList: results[0], indexesArr: results[1], foreignKey: results[2], referenced: results[3], triggers: results[4], statusArr: results[5]};

            if(dbType == 'mysql') {
                templatesP = {attrList: results[0], indexesArr: results[1], statusArr: results[2]};
            }

            templatesP.path = pathname;
            templatesP.tableName = table;
            templatesP.dbType = dbType;
            templatesP.authenticate = authenticate;

            just.render('tableDetails', templatesP, function(error, html) {
                showPageTotalRecords(response, error, html, db, connection, table);
            });
        }
    });
}

function showPageTotalRecords (response, error, html, db, connection, table) {
async.waterfall([
    function (done) {
        if (error) {
            console.log(error);
        }
        response.writeHead(200, {"Content-Type": "text/html"});
        response.write(html);
        done(null);
    },

    function (done) {
        db.rowsCounter(connection, table, done);
    }

    ], function (err, counter) {
        if (err) {
            showError (response, err, pathname);
        } else {
            just.render('totalRecords', {rowsCounter: counter}, function(error, html_counter) {
                if (err) {
                    console.log(err);
                }
                response.write(html_counter);
                response.end();
            });
        }
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
        if (err) {
            showError (response, err, pathname);
        } else {
            just.render('columnData', { columnData: results, authenticate: authenticate, path: pathname }, function(error, html) {
                showPage (response, error, html);
            });
        }
    });
}

function showValue(response, connection, pathname, dbType, table_groups, table, column, value) {
    var limit = 10;
    var db;
    async.waterfall([
        function (done){
            db = getDbType(dbType);
            db.showValueRequest(connection, table, column, value, done);
        }
    ], function (err, results) {
        if (err) {
            showError (response, err, pathname);
        }

        else if (results == 0) {
            showError(response, "The value '" + value + "' is not present in column '" + column + "'", pathname);
        }

        else {
            just.render('showValues', { values: results, limit: limit, authenticate: authenticate, path: pathname }, function(error, html) {
                showPage (response, error, html);
            });
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

function showError (req, response, msg) {
    var pathname = req._pathname; 
    just.render('msg', { breadcrumbs_path: pathname, 
            title: "404 Status", 
            authenticate: authenticate, 
            msg: msg }, function(error, html) {
        if (error) {
            console.log(error);
        }

        console.log(msg);
        response.writeHead(404, {"Content-Type": "text/html"});
        response.write(html);
        response.end();
    });
}

function cssConnect (response) {
    justStyle.render('style', {}, function(error, html) {
        showPage (response, error, html, 'css');
    });
}

function sqlRequest(response, connection, dbType, sql, pathname, dbId, reqName, user, comment, path_breadcrumbs, sqlId) {
   var path = pathname.replace(/\:/, '/');;
   var type = '';
   if(path_breadcrumbs) {
       path = path_breadcrumbs;
       type='total change';
   }
    async.waterfall([
        function (done){
            if ( /ALTER|create|drop/i.exec(sql) ) {
                 showError (response, "Request '" + sql + "' can not be executed", pathname);
            } else {
                done(null);
            }
        },

        function (done){
            var db = getDbType(dbType);
            db.getSQL(connection, sql, done);
        }

    ], function (err, results) {
        if (err) {
            showError (response, err, pathname);
        } else {
            async.parallel([
                function(done){
                    if (sqlId) {
                        sqlite.changeRequest(sql, dbId, reqName, user, comment, done, sqlId, 'execute');
                    } else {
                        sqlite.saveRequest(sql, dbId, reqName, user, comment, done);
                    }
                },

                function(done){
                    just.render('showSqlRequest', { authenticate: authenticate, path: path, sql: sql, results: results }, function(error, html) {
                        showPage (response, error, html);
                        done(null);
                    });
                }
            ], function (err, results) {
                if (err) {
                    showError(response, err, pathname);
                }
            });
        }
    });
}

function sqlHistory (response) {
    var limit = 20;

    async.waterfall([
        function (done){
            sqlite.history(done);
        }

    ], function (err, results) {
        if (err) {
            showError (response, err, pathname);
        } else {
            just.render('sqlHistory', { values: results, limit: limit, authenticate: authenticate}, function(error, html) {
                showPage (response, error, html);
            });
        }
    });
}

function sqlDetails (response, sqlId) {
    async.waterfall([
        function (done){
            sqlite.details(done, sqlId);
        }

    ], function (err, results) {
        if (err) {
            showError (response, err, pathname);
        } else {
            just.render('sqlDetails', { values: results, authenticate: authenticate, sqlId: sqlId, databaseList: config.db}, function(error, html) {
                showPage (response, error, html);
            });
        }
    });
}

function sqlSave (response, sql, reqName, comment, dbId, user, sqlId, type) {
    var bc_path = '/' + dbId + '/:sql/' + sqlId + '/saved';

    async.waterfall([
        function (done){
            sqlite.changeRequest(sql, dbId, reqName, user, comment, done, sqlId, 'save');
        }

    ], function (err, results) {
        if (err) {
            showError (response, err, bc_path);
        } else {
            just.render('msg', { breadcrumbs_path: bc_path, title: 'Saving status', msg: 'Saving was successful!', authenticate: authenticate}, function(error, html) {
                showPage (response, error, html);
            });
        }
    });
}

function sqlRemove (response, sqlId, dbId) {
    var bc_path = '/' + dbId + '/:sql/' + sqlId;

    async.waterfall([
        function (done){
            sqlite.remove(sqlId, done);
        }

    ], function (err, results) {
        if (err) {
            showError (response, err, bc_path);
        } else {
            just.render('msg', { breadcrumbs_path: bc_path, title: 'Removing status', msg: 'Removing was successful!', authenticate: authenticate}, function(error, html) {
                showPage (response, error, html);
            });
        }
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
exports.sqlRequest = sqlRequest;
exports.sqlHistory  = sqlHistory;
exports.sqlDetails  = sqlDetails;
exports.sqlSave = sqlSave;
exports.sqlRemove = sqlRemove;