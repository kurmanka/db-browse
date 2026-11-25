// Runs start.js with a config written to a temp dir, on a free port, with
// in-memory sessions and the SQL history in that dir: the real config.js,
// users.txt and usersRequests.sqlite are never touched.

'use strict';
const fs    = require('fs');
const net   = require('net');
const os    = require('os');
const path  = require('path');
const { spawn } = require('child_process');

function freePort() {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.on('error', reject);
        probe.listen(0, 'localhost', () => {
            const port = probe.address().port;
            probe.close(() => resolve(port));
        });
    });
}

// config(dir) returns the config object (it may name files in dir). Resolves
// { base, dir, stop() } once the server says it listens; rejects if it exits
// first.
async function spawnApp(prefix, config) {
    const dir  = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const file = path.join(dir, 'config.js');
    fs.writeFileSync(file, 'module.exports = ' + JSON.stringify(config(dir), null, 2) + ';\n');
    const port = await freePort();

    const child = spawn(process.execPath, ['start.js'], {
        cwd: path.join(__dirname, '..', '..'),
        env: Object.assign({}, process.env, {
            DBB_CONFIG: file, DBB_PORT: String(port), DBB_SESSION_MEMORY: '1',
            SQLITE_PATH: path.join(dir, 'usersRequests.sqlite')
        }),
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    const stop = () => {
        child.kill();
        fs.rmSync(dir, { recursive: true, force: true });
    };
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('start timed out: ' + out)), 10000);
        const onData = (c) => {
            out += c;
            if (/Server has started/.test(out)) { clearTimeout(timer); resolve(); }
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.on('exit', (code) => { clearTimeout(timer); reject(new Error('server exited (' + code + '): ' + out)); });
    }).catch((e) => { stop(); throw e; });

    return { base: 'http://localhost:' + port, dir, stop, output: () => out };
}

module.exports = { spawnApp };
