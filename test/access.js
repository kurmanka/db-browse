// Tests for access.js (per-database allow lists and superusers).
'use strict';
const assert = require('assert');
const access = require('../access.js');

let passed = 0;
let failed = 0;

function ok(label, fn) {
    try {
        fn();
        console.log('  PASS  ' + label);
        passed++;
    } catch (e) {
        console.log('  FAIL  ' + label);
        console.log('        ' + e.message);
        failed++;
    }
}

const config = {
    superusers: ['Root@Example.com', 'group:admins', 'ivan'],
    db: {
        open:   { type: 'sqlite' },
        sales:  { type: 'sqlite', allow: ['Ann@Example.com', 'group:analysts'] },
        locked: { type: 'sqlite', allow: [] },
        broken: { type: 'sqlite', allow: 'ann@example.com' },
    },
};

const can = (who, id) => access.canUse(config, who, id);

ok('email matches case-insensitively', () => assert.strictEqual(can({ name: 'ann@example.com' }, 'sales'), true));
ok('other email refused', () => assert.strictEqual(can({ name: 'bob@example.com' }, 'sales'), false));
ok('group match', () => assert.strictEqual(can({ name: 'bob@example.com', groups: ['analysts'] }, 'sales'), true));
ok('groups compared exactly', () => assert.strictEqual(can({ name: 'bob@example.com', groups: ['Analysts'] }, 'sales'), false));
ok('no allow key is open', () => assert.strictEqual(can({ name: 'bob@example.com' }, 'open'), true));
ok('anonymous who: open yes, sales no', () => {
    assert.strictEqual(can({ name: undefined, groups: undefined }, 'open'), true);
    assert.strictEqual(can({ name: undefined, groups: undefined }, 'sales'), false);
});
ok('allow [] is superusers only', () => {
    assert.strictEqual(can({ name: 'ann@example.com' }, 'locked'), false);
    assert.strictEqual(can({ name: 'root@example.com' }, 'locked'), true);
    assert.strictEqual(can({ name: 'IVAN' }, 'locked'), true);
    assert.strictEqual(can({ name: 'x', groups: ['admins'] }, 'locked'), true);
});
ok('malformed allow fails closed', () => {
    assert.strictEqual(can({ name: 'ann@example.com' }, 'broken'), false);
    assert.strictEqual(can({ name: 'ivan' }, 'broken'), true);
});
ok('ALL may use every database', () => assert.strictEqual(can(access.ALL, 'locked'), true));
ok('unknown / inherited ids are refused', () => {
    ['__proto__', 'constructor', 'toString', 'nope'].forEach(function (id) {
        assert.strictEqual(can(access.ALL, id), false, id);
    });
});
ok('visible keeps order and entries', () => {
    const v = access.visible(config, { name: 'ann@example.com' });
    assert.deepStrictEqual(Object.keys(v), ['open', 'sales']);
    assert.strictEqual(v.sales, config.db.sales);
});
ok('problems: broken allow', () => {
    const p = access.problems(config);
    assert.strictEqual(p.length, 1);
    assert.ok(/broken/.test(p[0]));
});
ok('problems: malformed superusers', () => {
    const p = access.problems({ superusers: 'ivan', db: {} });
    assert.strictEqual(p.length, 1);
    assert.ok(/superusers/.test(p[0]));
});
ok('problems: none', () => assert.deepStrictEqual(access.problems({ db: {} }), []));
ok('fromSession(undefined)', () => assert.deepStrictEqual(access.fromSession(undefined), { name: undefined, groups: undefined }));
ok('fromSession reads user and groups', () => assert.deepStrictEqual(
    access.fromSession({ user: 'a', groups: ['g'] }), { name: 'a', groups: ['g'] }));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
