import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from './fixture.mjs';

test('performance counters distinguish network bytes, partial decoder work and completed updates', () => {
    const {api, rfb} = fixture();
    api.receive('test-session', 'AQID'); api.receive('test-session', 'BA==');
    assert.equal(api.performance('test-session').receivedBytes, 4);
    assert.equal(api.performance('test-session').framebufferUpdates, 0);
    rfb.completeRect = false; rfb._handleRect();
    rfb.completeFrame = false; rfb._framebufferUpdate();
    let stats = api.performance('test-session');
    assert.equal(stats.rectangleCalls, 1); assert.equal(stats.rectanglesCompleted, 0);
    assert.equal(stats.framebufferUpdates, 0);
    rfb.completeRect = true; rfb._handleRect();
    rfb.completeFrame = true; rfb._framebufferUpdate();
    stats = api.performance('test-session');
    assert.equal(stats.rectanglesCompleted, 1); assert.equal(stats.encodings['1011'].rectangles, 1);
    assert.equal(stats.framebufferUpdates, 1); assert.ok(stats.decodeMilliseconds >= 0);
    assert.equal(stats.width, 100); assert.equal(stats.height, 50);
});

test('draw-bearing flips and flush completion waits are measured separately', async () => {
    const {api, rfb} = fixture();
    rfb._display.flip(); await rfb._display.flush();
    let stats = api.performance('test-session');
    assert.equal(stats.canvasDrawFlips, 1); assert.equal(stats.flushCompletions, 1);
    assert.ok(stats.canvasFlipMilliseconds >= 0); assert.ok(stats.flushWaitMilliseconds >= 0);
    rfb._display._damageBounds.right = 0; rfb._display.flip();
    stats = api.performance('test-session'); assert.equal(stats.canvasDrawFlips, 1);
});

test('encoding table is bounded and telemetry is scheduled only while connected', () => {
    const {api, rfb, messages, timers} = fixture();
    for (let value = 0; value < 100; value++) { rfb._FBU.encoding = value; rfb._handleRect(); }
    assert.equal(Object.keys(api.performance('test-session').encodings).length, 64);
    assert.equal(timers.length, 0);
    rfb.listeners.connect({detail: {}});
    assert.equal(timers.length, 1); assert.equal(timers[0].ms, 1000);
    timers[0].fn();
    const metrics = messages.filter(message => message.event === 'performance');
    assert.equal(metrics.length, 1);
    for (const forbidden of ['host', 'identity', 'username', 'password', 'clipboard', 'image'])
        assert.equal(forbidden in metrics[0].detail, false);
    rfb._rfbConnectionState = 'disconnected'; timers[0].fn();
    assert.equal(timers[0].cancelled, true);
    assert.equal(messages.filter(message => message.event === 'performance').length, 1);
});

test('transport closure cancels the metric timer', () => {
    const {api, rfb, timers} = fixture(); rfb.listeners.connect({detail: {}});
    api.transportClosed('test-session', 'fixture end');
    assert.equal(timers[0].cancelled, true);
});
