var http = require("http");
var url = require("url");
var config = require("./config");

function start(route, handle) {
    function onRequest(request, response) {
        var pathname = url.parse(request.url).pathname;
        pathname = pathname.replace(/\%20|;|,|\%22|\%27/g, '');// remove dangerous characters from url
        if (! /\.css/.exec(pathname) ) {
            console.log("Request for " + pathname + " received.");
        }

        route(handle, pathname, response, request);
    }

    http.createServer(onRequest).listen(config.listen.port, config.listen.host);
    console.log("Server has started. You can open in browse " + config.listen.host + ":" + config.listen.port);
}

exports.start = start;