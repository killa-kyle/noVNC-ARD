import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from './fixture.mjs';

test('native pointer masks preserve drag state and release on observe', () => {
    const {api, rfb} = fixture();
    api.pointer('test-session', 10, 20, 1);
    api.pointer('test-session', 30, 25, 1);
    api.observe('test-session', true);
    assert.deepEqual(rfb.pointerEvents, [
        {x:10,y:20,mask:1}, {x:30,y:25,mask:1}, {x:30,y:25,mask:0},
    ]);
    api.pointer('test-session', 5, 5, 1);
    assert.equal(rfb.pointerEvents.length, 3);
});

test('wheel masks do not become held mouse buttons and invalid masks are rejected', () => {
    const {api, rfb} = fixture();
    api.pointer('test-session', 10, 20, 8);
    api.pointer('test-session', 10, 20, 0);
    assert.equal(rfb._mouseButtonMask, 0);
    assert.deepEqual(rfb.pointerEvents.map(x=>x.mask), [8,0]);
    assert.throws(()=>api.pointer('test-session',10,20,128), /Invalid pointer mask/);
});
