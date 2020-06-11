Database browser
================

A lightweight node.js-based web application, targeted towards developer teams. 

Shows the tables, the columns, the indices and other overview details of a database (or several). 
Has a primitive built-in authentication support.

Supports Mysql and Postgresql databases.

Use "npm i" to install prerequisites.


Configuration
-------------

Application expects to find config.js in the server-local directory at start. Configuration
defines domain and port the app will listen on, all the databases it would expose (allow accessing), 
the session storage settings, etc.

Please see config.js.example for details and examples. 

Starting
--------

    node start.js

Add-ons
-------

Add-ons allow adding features, without rewriting the core app. It is an experiment.


JSON support
------------

Currently, the JSON values in a database are output in an indented form, but with no syntax highlighting 
or anything on top. Would be great to add JSON folding/unfolding support to that, e.g. with 
https://github.com/pgrabovets/json-view or https://github.com/mohsen1/json-formatter-js