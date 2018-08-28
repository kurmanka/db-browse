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

