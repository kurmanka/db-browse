var server = require("./server");
var router = require("./router");
var requestHandlers = require("./requestHandlers");

// connection methods for processing requests:
var handle = {}
handle["/"] = requestHandlers.selectDatabase;
handle["start"] = requestHandlers.start;
handle["showTable"] = requestHandlers.showTable;
handle["showColumn"] = requestHandlers.showColumn;
handle["cssConnect"] = requestHandlers.cssConnect;
handle["showError"] = requestHandlers.showError;

server.start(router.route, handle);