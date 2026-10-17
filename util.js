exports.getArrayOfStrings = function (string, done) {
    var array = [];
    var i = 0;

    while (/\S/.exec(string)) {
        var temp = /[^\n]+[\n\r]*/.exec(string);
        if (/\S/.exec(temp)) {
            array[i] = temp.join().replace(/\n|\r/g, '');
            i++;
        }
        string = string.replace(/[^\n]+[\n\r]*/, '');
    }

    done(null, array);
}


// The config file to load: $DBB_CONFIG (relative to the current directory)
// when set, else config.js next to this file. start.js and requestHandlers.js
// both require this path, so they share one config object.
exports.configPath = function () {
    var path = require('path');
    return process.env.DBB_CONFIG ? path.resolve(process.env.DBB_CONFIG)
                                  : path.join(__dirname, 'config.js');
}
