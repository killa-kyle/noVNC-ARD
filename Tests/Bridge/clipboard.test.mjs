// Exercise the original native adapter against a protocol-engine test double.
// This verifies dispatch/privacy semantics, not a real VNC wire or Mac server.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { test } from 'node:test';
import vm from 'node:vm';

function fixture() {
    const messages = [];
    const instances = [];
    class RFB {
        constructor() {
            this._asyncClipboard = {ungrab() {}};
            this._keyboard = {ungrab() {}};
            this._mouseButtonMask = 0;
            this._rfbAppleARD = false;
            this.listeners = {};
            this.sent = [];
            this.requests = 0;
            instances.push(this);
        }
        addEventListener(name, handler) { this.listeners[name] = handler; }
        disconnect() {}
        clipboardPasteFrom(text) { this.sent.push(text); this._clipboardText = text; }
        forceClipboardPaste() { throw new Error('ARD-only API must not be used for generic clipboard'); }
        requestRemoteClipboard() { this.requests++; }
        _resize() {}
        _negotiateRSATunnelAuthAsync() {}
        _negotiateARDAuthAsync() {}
    }
    const window = {crypto: webcrypto, isSecureContext: true,
        webkit: {messageHandlers: {kyleARD: {postMessage(body) { messages.push(JSON.parse(JSON.stringify(body))); }}}}};
    const context = vm.createContext({RFB, window, document: {getElementById() { return {}; }},
        TextEncoder, Uint8Array, ArrayBuffer, setTimeout, btoa, atob});
    const source = readFileSync(new URL('../../Sources/ARDWebAssets/Resources/Engine/bootstrap.js', import.meta.url), 'utf8')
        .replace(/^import .*;\n/gm, '');
    vm.runInContext(source, context);
    const api = window.KyleARD;
    api.connect({session: 'test-session', identity: 'fixed-host:5900'});
    return {api, rfb: instances[0], messages,
        clipboardEvents: () => messages.filter(message => message.event === 'clipboard')};
}

test('generic send chooses standard engine API and get uses last received server text', () => {
    const {api, rfb, clipboardEvents} = fixture();
    api.clipboard('test-session', 'send', 'local text');
    assert.deepEqual(rfb.sent, ['local text']);
    rfb._writeClipboard('remote text');
    api.clipboard('test-session', 'get');
    assert.equal(rfb.requests, 0, 'standard RFB has no fresh clipboard fetch command');
    assert.equal(clipboardEvents().at(-1).detail.text, 'remote text');
    assert.equal(clipboardEvents().at(-1).detail.cached, true);
    rfb._writeClipboard('');
    api.clipboard('test-session', 'get');
    assert.equal(clipboardEvents().at(-1).detail.text, '', 'empty server clipboard is a valid cache value');
});

test('revoke and Observe clear outgoing and received caches without stale replay', () => {
    const {api, rfb, messages, clipboardEvents} = fixture();
    api.clipboard('test-session', 'send', 'private outgoing');
    rfb._ardClipboardOutgoing = 'private ARD outgoing';
    rfb._writeClipboard('private incoming');
    api.clipboard('test-session', 'revoke');
    assert.equal(rfb._clipboardText, null);
    assert.equal(rfb._ardClipboardOutgoing, null);
    const count = clipboardEvents().length;
    api.clipboard('test-session', 'get');
    assert.equal(clipboardEvents().length, count);
    assert.equal(messages.at(-1).event, 'clipboardUnavailable');
    rfb._writeClipboard('new incoming');
    api.clipboard('test-session', 'send', 'new outgoing');
    api.observe('test-session', true);
    assert.equal(rfb._clipboardText, null);
    assert.equal(rfb._ardClipboardOutgoing, null);
    rfb._writeClipboard('blocked Observe incoming');
    api.clipboard('test-session', 'send', 'blocked Observe outgoing');
    api.observe('test-session', false);
    const afterObserve = clipboardEvents().length;
    api.clipboard('test-session', 'get');
    assert.equal(clipboardEvents().length, afterObserve);
    assert.deepEqual(rfb.sent, ['private outgoing', 'new outgoing']);
});

test('Apple clipboard get requests fresh data rather than returning generic cache', () => {
    const {api, rfb, clipboardEvents} = fixture();
    rfb._rfbAppleARD = true;
    rfb._writeClipboard('Apple text');
    const count = clipboardEvents().length;
    api.clipboard('test-session', 'get');
    assert.equal(rfb.requests, 1);
    assert.equal(clipboardEvents().length, count);
});
