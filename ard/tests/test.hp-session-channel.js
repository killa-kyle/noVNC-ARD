/*
 * Tests for HpSession adopting an already-open media channel (the
 * browser-direct DataChannel transport) instead of opening a WebSocket.
 * All data here is synthetic.
 *
 * Run: node --test ard/tests/test.hp-session-channel.js
 */

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import { deepStrictEqual, strictEqual, ok } from 'node:assert';

import { HpSession, MEDIA_SUBPROTOCOL } from '../hp/session.js';

// A WebSocket-shaped DataChannel facade whose events the test fires by hand.
class FakeChannel {
    constructor({ protocol = MEDIA_SUBPROTOCOL, readyState = 'open' } = {}) {
        this.protocol = protocol;
        this.readyState = readyState;
        this.binaryType = 'blob';
        this.sent = [];
    }

    send(data) { this.sent.push(new Uint8Array(data)); }
    deliver(bytes) { this.onmessage && this.onmessage({ data: new Uint8Array(bytes).buffer }); }
    fireOpen() { this.onopen && this.onopen(); }
    fireClose() { this.onclose && this.onclose({}); }
}

function throwingWebSocket() {
    return class {
        constructor() { throw new Error('WebSocket must not be constructed'); }
    };
}

describe('HpSession with an adopted media channel', () => {
    let session, states, logs, media;

    function create(channel, extra = {}) {
        states = [];
        logs = [];
        media = [];
        session = new HpSession(Object.assign({
            mediaChannel: channel,
            WebSocketImpl: throwingWebSocket(),
            now: () => Date.now(),
            sendOffer: () => {},
            onState: (state, reason) => states.push(reason ? state + ':' + reason : state),
            log: msg => logs.push(msg),
            createSink: () => ({ push() {}, close() {} }),
        }, extra));
        session._onMedia = data => media.push(data);
        session.start();
        return session;
    }

    beforeEach(() => {
        mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    });

    afterEach(() => {
        if (session) session.close();
        mock.timers.reset();
    });

    it('adopts the channel without constructing a WebSocket', async () => {
        const channel = new FakeChannel();
        create(channel);
        strictEqual(session._ws, channel);
        strictEqual(channel.binaryType, 'arraybuffer');
        await Promise.resolve();
        ok(logs.includes('media channel open'), 'logged: ' + logs.join('|'));
        strictEqual(session._wsOpen, true);
        strictEqual(session.state, 'idle');
    });

    it('treats numeric readyState 1 as already open', async () => {
        create(new FakeChannel({ readyState: 1 }));
        await Promise.resolve();
        strictEqual(session._wsOpen, true);
    });

    it('waits for onopen when the channel is still connecting', async () => {
        const channel = new FakeChannel({ readyState: 'connecting' });
        create(channel);
        await Promise.resolve();
        strictEqual(session._wsOpen, false);
        channel.fireOpen();
        strictEqual(session._wsOpen, true);
    });

    it('routes channel messages to the media handler', () => {
        const channel = new FakeChannel();
        create(channel);
        channel.deliver([1, 2, 3]);
        strictEqual(media.length, 1);
        deepStrictEqual(Array.from(new Uint8Array(media[0])), [1, 2, 3]);
    });

    it('rejects a channel that is not a media channel', async () => {
        create(new FakeChannel({ protocol: 'nope' }));
        await Promise.resolve();
        strictEqual(session.state, 'failed');
        strictEqual(session.failure, 'media-connect: not a media channel');
        ok(states.some(s => s.startsWith('failed:media-connect')), states.join('|'));
        strictEqual(session._wsOpen, false);
    });

    it('fails with media-connect when the channel closes before message 1', () => {
        const channel = new FakeChannel({ readyState: 'connecting' });
        create(channel);
        channel.fireClose();
        ok(states.includes('failed:media-connect'), states.join('|'));
    });

    it('fails with media-closed when the channel closes after message 1', () => {
        const channel = new FakeChannel();
        create(channel);
        session._message1 = {};
        channel.fireClose();
        ok(states.includes('failed:media-closed'), states.join('|'));
    });

    it('prefers the channel over a URL', () => {
        const channel = new FakeChannel();
        create(channel, { mediaUrl: 'ws://relay.test/media' });
        strictEqual(session._ws, channel);
    });
});
