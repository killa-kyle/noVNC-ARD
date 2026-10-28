import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import * as codec from '../../Sources/ARDWebAssets/Resources/Engine/clipboard-codec.js';

export function fixture() {
    const messages = [];
    const instances = [];
    class RFB {
        constructor() {
            this._asyncClipboard = {ungrab() {}};
            this._keyboard = {ungrab() {}};
            this._mouseButtonMask = 0;
            this._rfbAppleARD = false; this._rfbConnectionState = 'connected';
            this._FBU = {encoding: 1011};
            this._fbWidth = 100; this._fbHeight = 50;
            this._display = {pending() { return false; }};
            this.listeners = {};
            this.sent = [];
            this.requests = 0;
            instances.push(this);
        }
        get viewOnly() { return this._viewOnly; }
        set viewOnly(value) { this._viewOnly = value; }
        addEventListener(name, handler) { this.listeners[name] = handler; }
        disconnect() {}
        clipboardPasteFrom(text) { this.sent.push(text); this._clipboardText = text; }
        forceClipboardPaste() { throw new Error('ARD-only API must not be used for generic clipboard'); }
        requestRemoteClipboard() { this.requests++; }
        _resize() {}
        _framebufferUpdate() { return true; }
        _handleRect() { return true; }
        _fail(reason) { this.failure = reason; return false; }
        _negotiateRSATunnelAuthAsync() {}
        _negotiateARDAuthAsync() {}
    }
    RFB.messages = {ardClipboardSend(sock, format, session, bytes, expanded) {
        sock.sentArchive = {format, session, bytes, expanded};
    }};
    const window = {crypto: webcrypto, isSecureContext: true,
        webkit: {messageHandlers: {kyleARD: {postMessage(body) { messages.push(JSON.parse(JSON.stringify(body))); }}}}};
    const context = vm.createContext({RFB, window, document: {getElementById() { return {}; }},
        TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, performance, setTimeout, clearInterval, setInterval: () => 0, btoa, atob, ...codec});
    const source = readFileSync(new URL('../../Sources/ARDWebAssets/Resources/Engine/bootstrap.js', import.meta.url), 'utf8')
        .replace(/^import .*;\n/gm, '');
    vm.runInContext(source, context);
    const api = window.KyleARD;
    api.connect({session: 'test-session', identity: 'fixed-host:5900'});
    return {api, rfb: instances[0], messages, context,
        clipboardEvents: () => messages.filter(message => message.event === 'clipboard')};
}

