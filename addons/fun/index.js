// 'ect' is optional: it is this addon's template engine and nothing else in
// db-browse uses it. Require it in init(), not at module load, so the addon
// still loads (and its SQL-template features still work) without it.
var ect = null;

exports.init = function(a,c,home) {
	try {
		ect = require('ect')({ root: home + '/views', watch: true });
	} catch (e) {
		ect = null;
		console.log('addon fun: the template engine "ect" is not installed, so the ' +
		            '"show" feature is unavailable (' + e.message + ')');
	}
	// ...
	return true;
};

var render = 
exports.render = function(req, res, template, data) {
	if (!ect) {
		return res.status(500).send('The addon "fun" needs the template engine "ect", ' +
		                            'which is not installed. Run "npm install ect" to use it.');
	}
	console.log( 'render()', template, data );
	var html = ect.render(template, data);
	console.log( 'generated: ' + html );
	res.send( html );
};

exports.setup = function (a,c,home) {
	//
};


// there is:
//  - the SQL template
//  - a list of parameters
//  - each parameter may have a type and may have a value.
//  - if a parameter has no value,   
//

var sqlt =
exports.sqlt = {};

sqlt.get_file = {
	sqlt: 'select * from file where file_id= {id}',
	params: { id: 'string' },
};

sqlt.average_response_time = {
	sqlt: 
'select req_url_path, sum(resp_t_app) as sum_app_time, count(*) as count, \
  sum(resp_t_app) / count(*) as average from requests \
  where req_time between {start} and {end} \
  group by req_url_path having count(*) > {count} \
order by sum_app_time desc',
	params: { start: 'date', end: 'date', count: 'int' },
};

function _do (req, res, next) {
	req.dbconnection.query( 'select count(*) from product', [], 
		function(err,result) { res.json(result); } 
	);
//	res.send('do this & that');
}

var features = 
exports.features = {
	'do': _do,
	'show': function(req,res,n) { 
		console.log( 'show()' );
		render(req, res, 'show', {hello:'dolly'}); 
	},
};


