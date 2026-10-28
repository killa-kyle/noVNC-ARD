// Original KyleVNC adapter. Upstream noVNC/ARD code remains in its MPL files.
import RFB from './noVNC/core/rfb.js';
import './ard/ard-patch.js';

const MAX_CHUNK = 65536;
const MAX_QUEUE = 8 * 1024 * 1024;
let active = null;
const post = body => window.webkit.messageHandlers.kyleARD.postMessage(body);
const bytesToBase64 = bytes => {
    let text = '';
    for (let offset = 0; offset < bytes.length; offset += 8192)
        text += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    return btoa(text);
};
const fromBase64 = text => {
    if (typeof text !== 'string' || text.length > 4 * Math.ceil(MAX_CHUNK / 3))
        throw new Error('Oversized native byte chunk');
    const decoded = atob(text);
    if (decoded.length > MAX_CHUNK) throw new Error('Oversized native byte chunk');
    return Uint8Array.from(decoded, character => character.charCodeAt(0));
};
const requireSession = session => {
    if (!active || active.id !== session) throw new Error('Stale engine session');
    return active;
};
const event = (state, name, detail = {}) => {
    if (active === state) post({type: 'event', session: state.id, event: name, detail});
};
const fail = (state, reason) => {
    event(state, 'error', {reason});
    state.rfb?.disconnect();
    state.channel.close();
};
const drain = state => {
    if (active !== state || state.outstanding || !state.outgoing.length) return;
    const bytes = state.outgoing.shift();
    const sequence = ++state.sequence;
    state.outstanding = {sequence, length: bytes.length};
    post({type: 'write', session: state.id, sequence, base64: bytesToBase64(bytes)});
};
function performanceSnapshot(state) {
    return {elapsedMs: Math.max(0, performance.now() - state.started),
        receivedBytes: state.stats.receivedBytes, framebufferUpdates: state.stats.framebufferUpdates,
        rectangleCalls: state.stats.rectangleCalls, rectanglesCompleted: state.stats.rectanglesCompleted,
        decodeMilliseconds: state.stats.decodeMilliseconds, encodings: state.stats.encodings,
        canvasDrawFlips: state.stats.canvasDrawFlips, canvasFlipMilliseconds: state.stats.canvasFlipMilliseconds,
        flushCompletions: state.stats.flushCompletions, flushWaitMilliseconds: state.stats.flushWaitMilliseconds,
        width: state.rfb?._fbWidth || 0, height: state.rfb?._fbHeight || 0,
        renderPending: !!state.rfb?._display?.pending?.()};
}
function installDisplayMetrics(state) {
    const display = state.rfb._display;
    if (typeof display?.flip === 'function') {
        const original = display.flip;
        display.flip = function (fromQueue) {
            const draw = (fromQueue || !this.pending()) && this._damageBounds &&
                this._damageBounds.right > this._damageBounds.left && this._damageBounds.bottom > this._damageBounds.top;
            const started = performance.now();
            try { return original.call(this, fromQueue); }
            finally { if (draw && active === state) {
                state.stats.canvasDrawFlips++; state.stats.canvasFlipMilliseconds += Math.max(0, performance.now() - started);
            }}
        };
    }
    if (typeof display?.flush === 'function') {
        const original = display.flush;
        display.flush = function (...args) {
            const started = performance.now();
            return original.apply(this, args).then(value => {
                if (active === state) { state.stats.flushCompletions++;
                    state.stats.flushWaitMilliseconds += Math.max(0, performance.now() - started); }
                return value;
            });
        };
    }
}
function channelFor(state) {
    return {
        readyState: 'connecting', binaryType: 'arraybuffer', protocol: '',
        onopen() {}, onmessage() {}, onerror() {}, onclose() {},
        send(data) {
            if (this.readyState !== 'open') return;
            const bytes = data instanceof ArrayBuffer ? new Uint8Array(data)
                : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
            if (state.queuedBytes + bytes.length > MAX_QUEUE) {
                fail(state, 'Native transport send queue exceeded its limit'); return;
            }
            state.queuedBytes += bytes.length;
            for (let offset = 0; offset < bytes.length; offset += MAX_CHUNK)
                state.outgoing.push(bytes.slice(offset, offset + MAX_CHUNK));
            drain(state);
        },
        close() {
            if (this.readyState === 'closed') return;
            this.readyState = 'closed';
            clearInterval(state.performanceTimer); state.performanceTimer = null;
            state.outgoing = []; state.incoming = [];
            state.queuedBytes = 0; state.incomingBytes = 0;
            state.trustResolve?.(false); state.trustResolve = null;
            post({type: 'close', session: state.id});
        },
    };
}

// Never use upstream's URL/localStorage RSA cache with a raw channel. Native
// code approves the exact DER key before any RSA credential envelope is sent.
RFB.prototype._ardGetCachedRSAKey = () => null;
RFB.prototype._ardCacheRSAKey = function (der) {
    const state = active;
    if (!state || state.rfb !== this) throw new Error('No active key trust context');
    if (der.length > 8192) throw new Error('Oversized RSA key');
    state.trust = new Promise(resolve => { state.trustResolve = resolve; });
    event(state, 'hostkey', {
        identity: state.identity, kind: 'rsa-pkcs1', derBase64: bytesToBase64(der),
    });
};
const originalRSA = RFB.prototype._negotiateRSATunnelAuthAsync;
RFB.prototype._negotiateRSATunnelAuthAsync = async function (key) {
    const state = active;
    const accepted = state && state.rfb === this && state.trust && await state.trust;
    if (!accepted || active !== state) {
        if (state && active === state) fail(state, 'RSA host key was not approved');
        return;
    }
    return originalRSA.call(this, key);
};
const originalDH = RFB.prototype._negotiateARDAuthAsync;
RFB.prototype._negotiateARDAuthAsync = function (...args) {
    const state = active;
    if (!state || state.rfb !== this || !state.transportTrusted) {
        if (state) fail(state, 'ARD Diffie-Hellman requires a verified SSH transport');
        return;
    }
    return originalDH.apply(this, args);
};

// These are protocol completion/decode metrics, not estimated frame counts from
// socket chunks. Partial decoder work contributes time but not completed rects.
const originalFrameUpdate = RFB.prototype._framebufferUpdate;
RFB.prototype._framebufferUpdate = function (...args) {
    const complete = originalFrameUpdate.apply(this, args);
    if (complete && active?.rfb === this) active.stats.framebufferUpdates++;
    return complete;
};
const originalHandleRect = RFB.prototype._handleRect;
RFB.prototype._handleRect = function (...args) {
    const state = active; const encoding = this._FBU?.encoding;
    const started = performance.now();
    let complete = false;
    try { complete = originalHandleRect.apply(this, args); return complete; }
    finally {
        if (state && state === active && state.rfb === this) {
            const elapsed = Math.max(0, performance.now() - started);
            state.stats.rectangleCalls++; state.stats.decodeMilliseconds += elapsed;
            const key = String(encoding);
            if (!(key in state.stats.encodings) && Object.keys(state.stats.encodings).length < 64)
                state.stats.encodings[key] = {rectangles: 0, milliseconds: 0};
            const metric = state.stats.encodings[key];
            if (metric) { metric.milliseconds += elapsed; if (complete) metric.rectangles++; }
            if (complete) state.stats.rectanglesCompleted++;
        }
    }
};

// Browser clipboard APIs are never used; native UI controls all transfers.
RFB.prototype._writeClipboard = function (text) {
    const state = active;
    if (state && state.rfb === this && !this.viewOnly && typeof text === 'string') {
        if (text.length > 1024 * 1024) { fail(state, 'Oversized remote clipboard'); return; }
        if (!this._rfbAppleARD) state.lastGenericClipboard = text;
        event(state, 'clipboard', {text});
    }
};
const originalResize = RFB.prototype._resize;
RFB.prototype._resize = function (width, height) {
    const result = originalResize.call(this, width, height);
    if (active?.rfb === this) event(active, 'resize', {width, height});
    return result;
};

const api = {
    connect(config) {
        if (!config || typeof config.session !== 'string' || !config.session.length ||
            typeof config.identity !== 'string' || !config.identity.length)
            throw new Error('Missing native session or host identity');
        if (active) { active.rfb.disconnect(); active.channel.close(); active = null; }
        if (!window.crypto?.subtle || !window.isSecureContext)
            throw new Error('The engine requires WebCrypto in a secure WebKit context');
        const state = {
            id: config.session, identity: config.identity, transportTrusted: config.transportTrusted === true,
            outgoing: [], queuedBytes: 0, incoming: [], incomingBytes: 0, sequence: 0,
            outstanding: null, rfb: null, channel: null, trustResolve: null, trust: null, lastGenericClipboard: null,
            started: performance.now(), performanceTimer: null,
            stats: {receivedBytes: 0, framebufferUpdates: 0, rectangleCalls: 0, rectanglesCompleted: 0,
                decodeMilliseconds: 0, encodings: Object.create(null), canvasDrawFlips: 0, canvasFlipMilliseconds: 0,
                flushCompletions: 0, flushWaitMilliseconds: 0},
        };
        active = state;
        state.channel = channelFor(state);
        const credentials = {};
        if (typeof config.username === 'string') credentials.username = config.username;
        if (typeof config.password === 'string') credentials.password = config.password;
        state.rfb = new RFB(document.getElementById('desktop'), state.channel, {credentials});
        state.rfb.scaleViewport = true;
        state.rfb.resizeSession = false;
        installDisplayMetrics(state);
        state.rfb._asyncClipboard.ungrab();
        state.rfb._asyncClipboard = {grab() {}, ungrab() {}, writeClipboard() { return false; }};
        state.rfb.viewOnly = config.viewOnly === true;
        state.rfb._ardControlMode = config.viewOnly === true ? 0 : 1;
        state.rfb._ardQualityPreset = config.quality || 'adaptive';
        state.rfb._ardAskSessionChoice = true;
        state.rfb._ardVirtualLogin = 1;
        state.rfb._ardEncryptionMode = 2;
        state.rfb._ardHpAllowed = false;
        state.rfb._ardHpAudio = false;
        const listen = (name, handler) => state.rfb.addEventListener(name, ev => handler(ev.detail || {}));
        listen('connect', () => {
            event(state, 'connected');
            clearInterval(state.performanceTimer);
            state.performanceTimer = setInterval(() => {
                if (active !== state || state.rfb._rfbConnectionState !== 'connected') {
                    clearInterval(state.performanceTimer); state.performanceTimer = null; return;
                }
                event(state, 'performance', performanceSnapshot(state));
            }, 1000);
            event(state, 'resize', {width: state.rfb._fbWidth, height: state.rfb._fbHeight});
            event(state, 'capabilities', {apple: !!state.rfb._rfbAppleARD,
                curtain: !!state.rfb._rfbAppleARD, adaptive: !!state.rfb._rfbAppleARD,
                textClipboard: true, richClipboard: false});
        });
        listen('disconnect', detail => event(state, 'disconnected', {reason: detail.clean ? 'Disconnected' : 'Connection closed unexpectedly'}));
        listen('credentialsrequired', detail => event(state, 'credentials', {types: detail.types || []}));
        listen('securityfailure', detail => event(state, 'error', {reason: detail.reason || 'Authentication failed'}));
        listen('ardsessionselect', detail => {
            state.allowedSessions = {canShare: !!(detail.allowedCommands & 3), canPrivate: !!(detail.allowedCommands & 4)};
            event(state, 'session', {...state.allowedSessions, username: detail.username || ''});
        });
        listen('ardsessionchoice', detail => {
            state.allowedSessions = {canShare: true, canPrivate: false};
            event(state, 'session', {...state.allowedSessions, username: detail.username || ''});
        });
        listen('arddisplayinfo', detail => event(state, 'displays', detail));
        listen('ardcurtainchange', detail => event(state, 'curtain', {...detail, acknowledged: false}));
        listen('ardencryptionstate', detail => event(state, 'encryption', detail));
        post({type: 'open', session: state.id});
    },
    opened(session) {
        const state = requireSession(session);
        // Let the constructor install its channel handlers before onopen fires.
        setTimeout(() => {
            if (active !== state || state.channel.readyState !== 'connecting') return;
            state.channel.readyState = 'open'; state.channel.onopen();
            for (const bytes of state.incoming.splice(0)) {
                if (state.channel.readyState !== 'open') break;
                state.channel.onmessage({data: bytes.buffer});
            }
            state.incomingBytes = 0;
        }, 0);
    },
    receive(session, base64) {
        const state = requireSession(session); const bytes = fromBase64(base64);
        state.stats.receivedBytes += bytes.length;
        if (state.channel.readyState === 'connecting') {
            if (state.incomingBytes + bytes.length > MAX_QUEUE) {
                fail(state, 'Pre-open receive queue exceeded its limit'); return;
            }
            state.incomingBytes += bytes.length; state.incoming.push(bytes);
        } else if (state.channel.readyState === 'open') state.channel.onmessage({data: bytes.buffer});
    },
    ack(session, sequence) {
        const state = requireSession(session);
        if (state.outstanding?.sequence !== sequence) throw new Error('Out-of-order native write acknowledgment');
        state.queuedBytes -= state.outstanding.length; state.outstanding = null; drain(state);
    },
    transportClosed(session, reason = 'Native transport closed') {
        const state = requireSession(session);
        if (state.channel.readyState === 'closed') return;
        clearInterval(state.performanceTimer); state.performanceTimer = null;
        state.channel.readyState = 'closed'; state.trustResolve?.(false);
        state.channel.onclose({code: 1006, reason: String(reason).slice(0, 512)});
    },
    // Wait for native send acknowledgments before the caller closes the channel.
    // Bounded: a failed peer must never hold an application lifecycle transition.
    async flush(session) {
        const state = requireSession(session);
        const deadline = performance.now() + 1000;
        while (active === state && state.channel.readyState !== 'closed' && state.queuedBytes > 0) {
            if (performance.now() >= deadline) return false;
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        return active === state && state.channel.readyState !== 'closed' && state.queuedBytes === 0;
    },
    disconnect(session) { const state = requireSession(session); state.rfb.disconnect(); state.channel.close(); },
    credentials(session, username, password) { requireSession(session).rfb.sendCredentials({username, password}); },
    trust(session, accepted) {
        const state = requireSession(session); state.trustResolve?.(accepted === true); state.trustResolve = null;
    },
    key(session, keysym, down) {
        const state = requireSession(session); if (state.rfb.viewOnly) return;
        if (!Number.isInteger(keysym) || keysym < 0 || keysym > 0xffffffff) throw new Error('Invalid keysym');
        state.rfb.sendKey(keysym, null, down === true);
    },
    pointer(session, x, y, mask = 0) {
        const rfb = requireSession(session).rfb; if (rfb.viewOnly) return;
        if (!Number.isInteger(mask) || mask < 0 || mask > 127) throw new Error('Invalid pointer mask');
        if (![x, y].every(Number.isFinite) || x < 0 || y < 0 || x >= rfb._fbWidth || y >= rfb._fbHeight)
            throw new Error('Pointer is outside the framebuffer');
        const display = rfb._display;
        const localX = (x - display._viewportLoc.x) * display.scale;
        const localY = (y - display._viewportLoc.y) * display.scale;
        rfb._mousePos = {x: localX, y: localY};
        rfb._mouseButtonMask = mask & 7;
        rfb._sendMouse(localX, localY, mask);
    },
    type(session, text) {
        const state = requireSession(session); if (state.rfb.viewOnly) return;
        if (typeof text !== 'string' || text.length > 65536) throw new Error('Oversized typed text');
        for (const character of text) {
            const code = character.codePointAt(0);
            const keysym = code === 10 ? 0xff0d : code < 256 ? code : 0x01000000 | code;
            state.rfb.sendKey(keysym, null, true); state.rfb.sendKey(keysym, null, false);
        }
    },
    clipboard(session, operation, text = '') {
        const state = requireSession(session);
        if (operation === 'revoke') {
            state.rfb._ardClipboardOutgoing = null; state.rfb._clipboardText = null;
            state.lastGenericClipboard = null; return;
        }
        if (state.rfb.viewOnly) return;
        if (operation === 'get') {
            if (state.rfb._rfbAppleARD) state.rfb.requestRemoteClipboard();
            else if (state.lastGenericClipboard !== null)
                event(state, 'clipboard', {text: state.lastGenericClipboard, cached: true});
            else event(state, 'clipboardUnavailable', {reason: 'The RFB server has not sent clipboard content since it was cleared.'});
        }
        else if (operation === 'send') {
            if (typeof text !== 'string' || text.length > 1024 * 1024) throw new Error('Oversized clipboard');
            state.rfb.clipboardPasteFrom(text);
        } else throw new Error('Unknown clipboard operation');
    },
    curtain(session, active, message = '') {
        const state = requireSession(session); if (state.rfb.viewOnly) return;
        if (typeof message !== 'string' || new TextEncoder().encode(message).length > 4096) throw new Error('Oversized curtain message');
        if (active) state.rfb.ardCurtainLock(message); else state.rfb.ardCurtainUnlock();
    },
    selectSession(session, command) {
        const state = requireSession(session);
        if (command !== 1 && command !== 2) throw new Error('Invalid session selection');
        if ((command === 1 && !state.allowedSessions?.canShare) ||
            (command === 2 && !state.allowedSessions?.canPrivate)) throw new Error('Session type was not offered by server');
        if (state.rfb._ardSessionSelectStage === 'waitingForUI') state.rfb.selectSessionType(command);
        else { state.rfb._ardVirtualLogin = command === 2 ? 2 : 0; state.rfb.ardContinueSession(); }
    },
    selectDisplay(session, id) { requireSession(session).rfb.ardSelectedDisplay = id; },
    observe(session, enabled) {
        const state = requireSession(session); const rfb = state.rfb;
        if (enabled === true) {
            rfb._ardClipboardOutgoing = null; rfb._clipboardText = null; state.lastGenericClipboard = null;
        }
        if (enabled === true && !rfb.viewOnly) {
            // Release DOM hardware keys/buttons before viewOnly starts gating output.
            rfb._keyboard.ungrab();
            if (rfb._mouseButtonMask) rfb._sendMouse(rfb._mousePos.x, rfb._mousePos.y, 0);
            rfb._mouseButtonMask = 0;
        }
        rfb.viewOnly = enabled === true;
        rfb.ardControlMode = enabled === true ? 0 : 1;
    },
    performance(session) { return performanceSnapshot(requireSession(session)); },
    quality(session, preset) {
        if (!['adaptive', 'millions', 'thousands', 'gray', 'halftone'].includes(preset)) throw new Error('Invalid quality preset');
        requireSession(session).rfb.ardQualityPreset = preset;
    },
};
window.KyleARD = Object.freeze(api);
post({type: 'ready', detail: {bridgeVersion: 1, secureContext: window.isSecureContext, webCrypto: !!window.crypto?.subtle, upstream: 'd699293635083c9e0c30c8f9480993865653772a'}});
