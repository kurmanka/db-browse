

exports.init = function(a,c,home) {

	return {};
};


exports.setup = function (a,c,home) {
	a.get( '/fun', function(req,res,next) {
		res.send('have fun!');
	});

}