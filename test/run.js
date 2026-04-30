// Runs all test scripts sequentially.
'use strict';
const { execFileSync } = require('child_process');
const path = require('path');

const scripts = ['sqlite.js', 'routes.js'];
let anyFailed = false;

for (const script of scripts) {
    console.log('\n=== ' + script + ' ===');
    try {
        execFileSync(process.execPath, [path.join(__dirname, script)], {
            stdio: 'inherit',
            cwd: path.join(__dirname, '..'),
        });
    } catch (_) {
        anyFailed = true;
    }
}

if (anyFailed) process.exit(1);
