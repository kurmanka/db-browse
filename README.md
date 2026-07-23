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


To do
-----

These are some of the things I'd like to do:

* finish the transition to pug templates; delete the legacy view/ folder
* fix URL building in links properly; e.g. horizontal / vertical links don't take possible query params into account
* fix page layout — the top and the bottom should be fixed, non-scrollable
* add JSON support
* add selecting columns for view in /:db/:table/:column/:value
* add links for referring records — to find records pointing to this one. 
    e.g. when looking at a product, find all documents refering to this product or 
    when looking at a company, find all products of that company (the reverse 
    of foreign key `references` relation) 