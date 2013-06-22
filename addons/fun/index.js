var ECT = require('ect');
var ect;

exports.init = function(a,c,home) {
	ect = ECT({ root: home + '/views', watch: true });
	// ...
	return true;
};

var render = 
exports.render = function(req, res, template, data) {
	console.log( 'render()', template, data );
	if (!ect) console.log( 'no ect' );
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

var sqlt = {};

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

function create_sqlt_feature( sqlt ) {
	return function( req, res, n ) {
		run_sqlt( sqlt, req, res, n );
	};
}

function run_sqlt( sqlt, req, res, next ) {
	res.locals.sqlt = sqlt;
	var values = {};

	for( var i in sqlt.params ) {
		if (req.query[i]) { values[i] = req.query[i]; }
		else if (req.body[i]) { values[i] = req.body[i]; }
	}

	var sa = apply_values( sqlt.sqlt, sqlt.params, values );

	if ( sa.missing ) {
		// error
		// show a form
		res.send( {missing: sa.missing} );

	} else {

		req.dbconnection.query( sa.sql, 
			sa.par,
			function(err,result) {
				if (err) {
					res.json(
						{error: err, 
						 sql: sa.sql } );
				} else res.json( {
					'sqlt':   sqlt.sqlt,
					'sql':    sa.sql, 
					'values': values, 
					'result': result 
				} ); 
			} 
		);

	}
}


function apply_values( t, p, v ) {
	var s = t;
	var missing = [];
	var par = [];
	console.log( 'apply_values()', t);

	for( var i in p ) {
		console.log( 'par', i, 'value', v[i] );
		if (v[i]=== undefined) { 
			// complain!
			// XXX
			missing.push( i );

		} else { 
			var re = new RegExp( '\\{' + i + '\\}', 'g' );
			console.log( re );

			if (   p[i] == 'string'
				|| p[i] == 'date' 
				|| p[i] == 'int' ) {

				s = s.replace( re, '$' + (par.length + 1).toString() );
				par.push( v[i] );

			} else {
				s = s.replace( re, v[i] );

			}
		}
	}
	if (missing.length) {
		console.log( 'missing: ', missing );
		return {sql:s, missing: missing, par: par};
	}
	console.log( 'apply_values(): sql', s );
	console.log( 'apply_values(): par', par );
	return {sql: s, par: par};
}


function check_sqlt_params(req, res, next) {
	var sqlt   = res.locals.sqlt;
	var params = res.locals.params;
	var values = res.locals.values;
	
	var empty_params = [];
	for (var i in params) {
		if (values[i]) {}
		else { empty_params.push(i); }
	}

	return empty_params;
}



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

for (var i in sqlt) {
	var s = sqlt[i];
	features[i] = create_sqlt_feature( s );
}


