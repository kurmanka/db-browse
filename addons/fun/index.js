
exports.init = function(a,c,home) {

	return {};
};

exports.setup = function (a,c,home) {
	a.get( '/fun', function(req,res,next) {
		res.send('have fun!');
	});

}

function _do (req, res, next) {
	req.dbconnection.query( 'select count(*) from product', [], 
		function(err,result) { res.json(result); } 
	);
//	res.send('do this & that');
}

exports.features = {
	'do': _do,

};
