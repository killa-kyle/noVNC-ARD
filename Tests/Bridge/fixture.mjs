import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';

export function fixture() {
    const messages = [];
    const instances = [];
    const timers = [];
    class RFB {
        constructor(_target, channel) {
            this.channel = channel;
            this._asyncClipboard = {ungrab() {}};
            this._keyboard = {ungrab() {}};
            this._mouseButtonMask = 0;
            this._rfbAppleARD = false;
            this._rfbConnectionState = 'connected'; this._fbWidth = 100; this._fbHeight = 50;
            this._FBU = {encoding: 1011};
            this._display = {pending() { return false; }, _damageBounds: {left: 0, right: 20, top: 0, bottom: 10},
                flip() {}, flush() { return Promise.resolve(); }, _viewportLoc: {x: 0, y: 0}, scale: 1};
            this.listeners = {};
            this.sent = [];
            this.requests = 0;
            instances.push(this);
        }
        addEventListener(name, handler) { this.listeners[name] = handler; }
        _sendMouse(x, y, mask) { (this.pointerEvents ||= []).push({x,y,mask}); }
        disconnect() {}
        clipboardPasteFrom(text) { this.sent.push(text); this._clipboardText = text; }
        forceClipboardPaste() { throw new Error('ARD-only API must not be used for generic clipboard'); }
        requestRemoteClipboard() { this.requests++; }
        _resize() {}
        _framebufferUpdate() { return this.completeFrame ?? true; }
        _handleRect() { return this.completeRect ?? true; }
        _negotiateRSATunnelAuthAsync() {}
        _negotiateARDAuthAsync() {}
    }
    const window = {crypto: webcrypto, isSecureContext: true,
        webkit: {messageHandlers: {kyleARD: {postMessage(body) { messages.push(JSON.parse(JSON.stringify(body))); }}}}};
    const context = vm.createContext({RFB, window, document: {getElementById() { return {}; }},
        TextEncoder, Uint8Array, ArrayBuffer, setTimeout, btoa, atob, performance,
        setInterval(fn, ms) { const timer = {fn, ms, cancelled: false}; timers.push(timer); return timer; },
        clearInterval(timer) { if (timer) timer.cancelled = true; }});
    const source = readFileSync(new URL('../../Sources/ARDWebAssets/Resources/Engine/bootstrap.js', import.meta.url), 'utf8')
        .replace(/^import .*;\n/gm, '');
    vm.runInContext(source, context);
    const api = window.KyleARD;
    api.connect({session: 'test-session', identity: 'fixed-host:5900'});
    return {api, rfb: instances[0], messages, timers,
        clipboardEvents: () => messages.filter(message => message.event === 'clipboard')};
}

