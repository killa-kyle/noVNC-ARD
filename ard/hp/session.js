/*
 * High Performance mode — one session.
 *
 * Ties the pieces together (ARD protocol spec, Section 14):
 *
 *   idle ──Message 1──► offering ──answer──► waiting ──first frame──► streaming
 *     └──────────────── any failure ─────────────────────────────────► failed
 *
 * The RFB layer hands in Message 1 and the answer as they arrive on TCP and
 * sends the offer this session builds. Media travels on a second WebSocket
 * to the relay: each message is one channel byte (0 audio, 1 video) and one
 * UDP datagram, or (channel 2) the agent's control frame.
 *
 * The bit-rate tier the offer asks for is the TierController's: sampled from
 * receive stats, recoveries and the agent's budget, applied by re-offering.
 */

import {
    parseMessage1, generateSecrets, buildOffer, parseAnswer, splitKeyBlock, parseStreamPorts,
    parseStreamError, STREAM_ERROR_IN_USE, parseAgentControl, AGENT_CONTROL_CHANNEL,
} from './negotiation.js';
import { createContext } from './srtp.js';
import { VideoAssembler } from './rtp-video.js';
import { receiverReport, pictureAck, rateControl, pli, fir } from './feedback.js';
import { TierController } from './rate-tier.js';
import { ReceiveStats } from './receive-stats.js';
import { PAYLOAD_TYPE_HEVC, TIERS } from './offer-template.js';

// WebSocket subprotocol a relay's media endpoint answers to.
export const MEDIA_SUBPROTOCOL = 'ard-media';

export const CHANNEL_AUDIO = 0;
export const CHANNEL_VIDEO = 1;
export const CHANNEL_CONTROL = AGENT_CONTROL_CHANNEL;

/*
 * Whether the RFB connection carries on (in Standard) after a failure with
 * this reason. Only when the server never opened the negotiation: it did not
 * send Message 1, or it refused the mode outright. Any later failure leaves
 * the server in a state nobody has mapped, so the viewer reconnects.
 */
const KEEPS_SESSION = new Set(['no-message1', 'in-use', 'refused']);

export function hpFailureKeepsSession(reason) {
    return KEEPS_SESSION.has(reason);
}

const MEDIA_CONNECT_MS = 3000;
const MESSAGE1_MS = 5000;
const ENCRYPTION_MS = 5000;
const ANSWER_MS = 5000;
const FIRST_FRAME_MS = 5000;
const REPORT_MS = 1000;
const RATE_CONTROL_MS = 50;
// How often the tier controller is sampled.
export const TIER_EVAL_MS = 1000;
// A stream starts with a burst (key pictures, the backlog of the switch), so
// for this long after each start its loss and delay are no evidence about
// the path and the controller does not see them.
export const TIER_GRACE_MS = 3000;
// A stored tier older than this is not this path's any more.
export const TIER_STORED_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// A stored tier from further ahead than this is from a wrong clock.
export const TIER_STORED_MAX_AHEAD_MS = 60 * 1000;
// A lower tier is stored only once it has streamed this long: the downs of
// a session that is dying are no lesson for the next one.
export const TIER_PERSIST_DOWN_MS = 10000;
// The agent's budget counts only from a control frame this recent.
const AGENT_CONTROL_MAX_AGE_MS = 3000;
// Where the tier this browser last held for a Mac is kept, by tierKey.
export const TIER_STORAGE_PREFIX = 'ardHpTier:';

// Nothing can be dropped from the stream without spoiling what follows, so
// a viewer that cannot keep up falls further and further behind. Half a
// second of pictures waiting for the decoder, or this many packets waiting
// to be decrypted, is normal for a moment when a stream starts; lasting
// this long it is a machine that is too slow, and the session ends.
const OVERLOAD_PICTURES = 120;
const OVERLOAD_PACKETS = 2000;
const OVERLOAD_MS = 2000;

// The server sends sound a hundred times a second whether or not there is
// any, so a few seconds without a single packet means it has stopped
// sending, which a server may do without a word on the RFB connection. The
// picture would stay as it was, looking alive.
const MEDIA_SILENCE_MS = 3000;

// This long with no new *completed picture* while video packets keep coming
// means the picture is frozen: bytes flow but never finish a picture. That
// is a freeze with a full byte stream (seen at the largest sizes, with sound
// masking it). No video at all is not one: at low rates the Mac sends none
// for a still screen (it drops repeated frames), and a server that stopped
// is the MEDIA_SILENCE_MS watchdog's. A lost picture is the key wait's,
// with its own limit (KEY_WAIT_MS).
const PICTURE_STALL_MS = 3000;
// Video after a break this long is a new flow (a still screen that changed):
// the freeze watchdog counts from its start, not from the last picture.
export const VIDEO_GAP_MS = 1000;

// The Mac sends a key picture only when a stream starts, so a lost picture
// leaves nothing to decode from until it is asked for one. A stream with no
// key picture this long after its first video packet asks too.
export const KEY_FIRST_MS = 1000;
// While waiting, ask again this often: FIR, then PLI, by turns.
export const KEY_RETRY_MS = 300;
// No key picture this long after the first request: the stream is stuck,
// and the session recovers by re-offering.
export const KEY_WAIT_MS = 2000;

// After a resize, how long to keep the old picture (blurred) waiting for the
// new one to be fully drawn before showing the new stream regardless.
const RESIZE_SHOW_MS = 2500;

// When the stream glitches (a lost picture, a silence, a backlog) the viewer
// re-offers on the live connection to restart the media instead of tearing
// the whole session down. Only this many recoveries in this window; beyond
// that the trouble is not passing, and it falls back to Standard.
const RECOVERY_MAX = 3;
const RECOVERY_WINDOW_MS = 30000;
const RECOVERABLE = new Set(['stalled', 'media-stopped', 'overloaded']);

// RTP clock rates of the two streams, in units per second.
const VIDEO_CLOCK = 90000;
const AUDIO_CLOCK = 48000;

function defaultStorage() {
    try {
        return globalThis.localStorage || null;
    } catch (e) {
        return null;    // storage blocked for this page
    }
}

function isRtcp(packet) {
    return packet.length > 1 && packet[1] >= 192 && packet[1] <= 223;
}

export class HpSession {
    /*
     * mediaUrl:        WebSocket URL of the relay's media endpoint
     * sendOffer(bytes): send the 0x1c message on the RFB connection
     * mediaChannel:    optional already-created WebSocket-shaped channel (a DataChannel
     *                  facade) adopted instead of opening mediaUrl
     * holdOffer:       true if the RFB connection is still to be encrypted. The offer
     *                  carries the media keys, so it waits for releaseOffer().
     * createSink({ width, height, stripes, onFirstFrame, onError }): → { push(picture), close() }
     *                  and optionally `backlog`, the pictures it has not decoded yet
     * createAudio():   optional; resolves to { push(rtp), close() } that plays the sound.
     *                  Without it, or if it fails, audio packets are counted and dropped.
     * onState(state, reason): called on every state change
     * feedback:        { reports, acks, rateControl } — which RTCP to send
     * endpoint:        how the viewer describes itself in the offer
     * tier:            a start tier (kbit/s) that overrides the stored one
     * tierKey:         which Mac this is, for the stored tier (localStorage
     *                  'ardHpTier:<tierKey>'); without it nothing is stored.
     *                  A higher tier is stored at once, a lower one once it
     *                  has streamed TIER_PERSIST_DOWN_MS
     * maxKbit:         operator cap on the tier
     * onTier(tier):    called on every tier change
     * storage:         localStorage stand-in (default globalThis.localStorage)
     */
    constructor({ mediaUrl, mediaChannel, sendOffer, holdOffer, createSink, createAudio, audioMuted, onState,
                  onResize, feedback, endpoint, tier, tierKey, maxKbit, onTier, storage,
                  WebSocketImpl, now, log, warn }) {
        this._mediaUrl = mediaUrl;
        this._mediaChannel = mediaChannel || null;
        this._sendOffer = sendOffer;
        this._offerHeld = !!holdOffer;
        this._createSink = createSink;
        this._createAudio = createAudio;
        this._audio = null;
        this._audioMuted = !!audioMuted;
        this._onState = onState || (() => {});
        this._onResize = onResize || (() => {});
        this._feedback = Object.assign({ reports: true, acks: true, rateControl: true }, feedback);
        this._endpoint = endpoint;
        this._WebSocket = WebSocketImpl || globalThis.WebSocket;
        this._now = now || (() => performance.now());
        this._log = log || (() => {});
        this._warn = warn || this._log;
        this._onTier = onTier || (() => {});
        this._storage = storage !== undefined ? storage : defaultStorage();
        this._tierKey = tierKey ? String(tierKey) : null;
        this._maxKbit = maxKbit;

        // Start: the tier asked for, else the one this browser last held
        // for this Mac, else the controller's own; never above the cap.
        const start = TIERS.includes(tier) ? tier : this._storedTier();
        this._tierCtl = new TierController({ start: start === null ? undefined : start, maxKbit });
        this.tier = this._tierCtl.tier;
        this._tierWhy = null;               // what moved the controller last
        this._tierToStore = null;           // a lower tier not yet stored: { tier, at }
        this._lastTierEvalAt = null;
        this._streamStartAt = null;         // when the current stream began, for TIER_GRACE_MS
        this._agentControl = null;          // last control frame, with its arrival time

        this.state = 'idle';
        this.failure = null;
        this.stats = {
            videoPackets: 0, videoBytes: 0, audioPackets: 0, audioBytes: 0, rtcpPackets: 0,
            authFailures: 0, pictures: 0, keyPictures: 0, sent: 0, controlFrames: 0, controlRejected: 0,
            keyRequests: 0, keyWaits: 0, keyAnswered: 0,
        };

        this._ws = null;
        this._wsOpen = false;
        this._message1 = null;
        this._secrets = null;
        this._answer = null;
        this._ctx = null;           // { audioIn, audioOut, videoIn, videoOut }
        this._assembler = null;
        this._sink = null;
        this._reoffering = false;   // a re-offer is in flight
        this._reofferKind = null;   // 'resize', 'recovery' or 'tier'
        this._pendingSecrets = null;
        this._resizeSignalled = false;  // onResize(true) sent, onResize(false) owed
        this._resizeOldSink = null;     // kept alive until the new picture shows
        this._recoveryAt = [];          // recent recovery times, for the cap
        this._reofferGen = 0;           // which re-offer a pending timer belongs to
        this._timers = new Set();
        this._intervals = new Set();
        this._sendChain = [Promise.resolve(), Promise.resolve()];
        this._recvStats = new ReceiveStats();
        this._lastVideoPacketAt = null;
        this._videoFlowSince = null;             // video packets without a VIDEO_GAP_MS break since
        this._lastPictureAt = null;              // when a picture last completed
        this._lastMediaAt = null;                // last packet of either stream that verified
        this._lastSenderReport = [null, null];   // per channel: { middle, at }
        this._decrypting = 0;                    // packets handed to SRTP and not back yet
        this._overloadedSince = null;
        // Asking for a key picture, per live stream.
        this._keyWait = null;                    // { reason, at, requests, retries } while asking
        this._firSeq = 0;                        // the last FIR's sequence number
        this._streamVideoAt = null;              // the stream's first video packet
        this._streamKeySeen = false;             // the stream has had a key picture
    }

    // The picture size and stripe count from the server's answer.
    get video() {
        return this._answer ? this._answer.video : null;
    }

    get audioReady() {
        return !!this._audio;
    }

    // Silence the sound without stopping it.
    setAudioMuted(muted) {
        this._audioMuted = !!muted;
        if (this._audio && this._audio.setMuted) this._audio.setMuted(this._audioMuted);
    }

    // ----- lifecycle -----

    start() {
        if (this.state !== 'idle' || this._ws) return;
        let ws;
        if (this._mediaChannel) {
            ws = this._mediaChannel;          // adopt an already-open channel (DC facade)
        } else {
            try {
                ws = new this._WebSocket(this._mediaUrl, MEDIA_SUBPROTOCOL);
            } catch (e) {
                this._fail('media-connect', e.message);
                return;
            }
        }
        ws.binaryType = 'arraybuffer';
        this._ws = ws;
        this._log('media transport ' + (this._mediaChannel
            ? 'DataChannel(adopted) readyState=' + this._mediaChannel.readyState
            : 'WebSocket ' + this._mediaUrl));
        const onOpen = () => {
            // A plain TCP proxy accepts any path and would hand us the
            // server's RFB greeting here. Only a relay's media endpoint
            // agrees to the subprotocol; a DataChannel facade reports its
            // label ('ard-media') as protocol.
            if (ws.protocol !== MEDIA_SUBPROTOCOL) {
                this._fail('media-connect', 'not a media channel');
                return;
            }
            this._wsOpen = true;
            this._log('media channel open');
            this._maybeOffer();
        };
        ws.onmessage = ev => this._onMedia(ev.data);
        ws.onclose = () => {
            this._wsOpen = false;
            if (this.state !== 'closed' && this.state !== 'failed') {
                this._fail(this.state === 'idle' && !this._message1 ? 'media-connect' : 'media-closed');
            }
        };
        ws.onerror = () => {};   // a close event follows
        // An adopted DataChannel may already be open; it will fire no onopen.
        const alreadyOpen = ws.readyState === 'open' || ws.readyState === 1;
        ws.onopen = onOpen;
        if (alreadyOpen) queueMicrotask(onOpen);
        this._timeout(MEDIA_CONNECT_MS, () => {
            if (!this._wsOpen) this._fail('media-connect', 'timeout');
        });
        this._timeout(MESSAGE1_MS, () => {
            if (!this._message1) this._fail('no-message1');
        });
    }

    close() {
        if (this.state === 'closed') return;
        this._teardown();
        this._setState('closed');
    }

    _teardown() {
        for (const t of this._timers) clearTimeout(t);
        for (const t of this._intervals) clearInterval(t);
        this._timers.clear();
        this._intervals.clear();
        if (this._sink) {
            this._sink.close();
            this._sink = null;
        }
        if (this._resizeOldSink) {
            this._resizeOldSink.close();
            this._resizeOldSink = null;
        }
        if (this._audio) {
            this._audio.close();
            this._audio = null;
        }
        this._torn = true;
        this._reoffering = false;
        this._keyWait = null;
        this._pendingSecrets = null;
        this._resizeDone();
        if (this._ws) {
            const ws = this._ws;
            this._ws = null;
            ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
            try { ws.close(); } catch (e) { /* already closed */ }
        }
        this._wsOpen = false;
    }

    _fail(reason, detail) {
        if (this.state === 'failed' || this.state === 'closed') return;
        this.failure = detail ? reason + ': ' + detail : reason;
        this._log('failed: ' + this.failure + ' ' + JSON.stringify(this.stats));
        this._teardown();
        this._setState('failed', reason);
    }

    _setState(state, reason) {
        if (this.state === state) return;
        this.state = state;
        this._onState(state, reason);
    }

    _timeout(ms, fn) {
        const t = setTimeout(() => {
            this._timers.delete(t);
            fn();
        }, ms);
        this._timers.add(t);
        return t;
    }

    _interval(ms, fn) {
        const t = setInterval(fn, ms);
        this._intervals.add(t);
        return t;
    }

    // ----- negotiation -----

    // The payload of the rectangle with encoding 1110.
    handleMessage1(payload) {
        if (this.state !== 'idle' || this._message1) return;
        try {
            this._message1 = parseMessage1(payload);
        } catch (e) {
            this._fail('bad-message1', e.message);
            return;
        }
        this._log('server offers High Performance (' + this._message1.model + ')');
        if (this._offerHeld) {
            this._timeout(ENCRYPTION_MS, () => {
                if (this._offerHeld) this._fail('no-encryption');
            });
        }
        this._maybeOffer();
    }

    // The RFB connection is encrypted now: the offer may be sent on it.
    releaseOffer() {
        if (!this._offerHeld) return;
        this._offerHeld = false;
        this._maybeOffer();
    }

    // The offer goes out once the server has asked and the media channel is
    // up: the server starts sending as soon as it has answered. It holds
    // the keys of the media, so it also waits for a connection that is
    // about to be encrypted.
    _maybeOffer() {
        if (this.state !== 'idle' || !this._message1 || !this._wsOpen || this._offerHeld) return;
        this._setState('offering');
        this._secrets = generateSecrets();
        buildOffer(this._secrets, { endpoint: this._endpoint, tier: this.tier }).then((offer) => {
            if (this.state !== 'offering') return;
            this._sendOffer(offer);
            this._timeout(ANSWER_MS, () => {
                if (this.state === 'offering') this._fail('no-answer');
            });
        }, e => this._fail('offer', e.message));
    }

    // The payload of the rectangle with encoding 1010.
    handleAnswer(payload) {
        // The same rectangle brings the server's ports before a negotiation.
        // Usually that is before the offer; a server slow to make its
        // display sent it after, and it was taken for an answer.
        const ports = parseStreamPorts(payload);
        if (ports) {
            this._log('server ports: audio ' + ports.audioPort + ', video ' + ports.videoPort);
            return;
        }
        // Or the server's refusal, which can come before Message 1: nothing
        // more will follow, so stop now rather than wait for a timeout.
        const error = parseStreamError(payload);
        if (error) {
            const inUse = error.type === STREAM_ERROR_IN_USE.type &&
                error.subCode === STREAM_ERROR_IN_USE.subCode;
            this._fail(inUse ? 'in-use' : 'refused', 'error ' + error.type + '/' + error.subCode);
            return;
        }
        // A re-offer sent during a session: swap the stream in without
        // disturbing the picture on screen. A resize's or a tier change's
        // failure is not the session's; the old stream stays. A recovery has
        // no stream to fall back on.
        if (this._reoffering && this.state === 'streaming') {
            this._swapMedia(payload).catch((e) => {
                const fatal = this._reofferFatal();
                this._reofferLost(this._reofferKind + ' re-offer answer failed: ' + (e && e.message ? e.message : e));
                this._endReoffer();
                this._resizeDone();
                if (fatal) this._fail('bad-answer', e && e.message ? e.message : String(e));
            });
            return;
        }
        if (this.state !== 'offering' || this._answering) return;
        this._answering = true;
        this._startMedia(payload).catch(e => this._fail('bad-answer', e.message));
    }

    // Ask for another bit-rate tier: a re-offer carrying it. False when it
    // cannot go now (not streaming, or a re-offer is already under way), or
    // the tier is not one of TIERS or is above the operator cap. A tier
    // asked for from outside becomes the controller's new starting point.
    setTier(tier, reason = 'requested') {
        if (!TIERS.includes(tier)) return false;
        if (this.state !== 'streaming' || this._reoffering) return false;
        if (tier !== this._tierCtl.tier) {
            const ctl = new TierController({ start: tier, maxKbit: this._maxKbit });
            if (ctl.tier !== tier) return false;
            this._tierCtl = ctl;
        }
        this._adoptTier(tier, reason);
        this._reoffer('tier');
        return true;
    }

    // Ask the server for a new picture size on the open connection: send a
    // fresh offer. The RFB layer has already sent the new VirtualDisplay
    // (0x1d). The picture on screen stays until the new one is ready.
    reoffer() {
        this._reoffer('resize');
    }

    _reoffer(kind) {
        if (this.state !== 'streaming' || this._reoffering) return;
        this._reoffering = true;
        this._reofferKind = kind;
        // The new stream will start with a key picture; asking the old one
        // for one is moot, and its wait is no reason to recover.
        this._keyWait = null;
        const gen = ++this._reofferGen;
        // The switch gap is not silence and not a freeze.
        this._lastMediaAt = this._now();
        this._lastPictureAt = this._now();
        if (!this._resizeSignalled) { this._resizeSignalled = true; this._onResize(true); }
        this._pendingSecrets = generateSecrets();
        buildOffer(this._pendingSecrets, { endpoint: this._endpoint, tier: this.tier }).then((offer) => {
            if (this._reofferGen !== gen || !this._reoffering) return;
            this._sendOffer(offer);
            this._timeout(ANSWER_MS, () => {
                // Only this re-offer's own timer acts; a later one has a new gen.
                if (this._reofferGen !== gen || !this._reoffering) return;
                const kind = this._reofferKind;
                const fatal = this._reofferFatal();
                this._reofferLost(kind + ': no answer');
                this._endReoffer();
                this._resizeDone();
                if (fatal) this._fail('media-stopped', kind + ' got no answer');
            });
        }, (e) => {
            if (this._reofferGen !== gen) return;
            const fatal = this._reofferFatal();
            this._reofferLost(this._reofferKind + ' re-offer failed: ' + e.message);
            this._endReoffer();
            this._resizeDone();
            if (fatal) this._fail('offer', e.message);
        });
    }

    // A resize or a tier change that fails leaves the old stream running (the
    // tier stays as chosen; the next re-offer carries it). If the old stream
    // has stopped after all, the silence and freeze watchdogs start a real
    // recovery. A recovery that fails has nothing left to fall back on.
    _reofferFatal() {
        return this._reofferKind === 'recovery';
    }

    // How a re-offer that came to nothing is logged.
    _reofferLost(what) {
        if (this._reofferKind === 'resize') this._log(what);
        else this._warn(what + (this._reofferFatal() ? '' : '; keeping the old stream'));
    }

    // ----- the bit-rate tier -----

    // The tier this browser last held for this Mac within the last day, or
    // null. Stored as {"tier", "at" (Unix ms)}; a bare number (an earlier
    // build) is taken without an age. A time well in the future is no time.
    _storedTier() {
        if (!this._tierKey || !this._storage) return null;
        let value;
        try {
            const raw = this._storage.getItem(TIER_STORAGE_PREFIX + this._tierKey);
            if (raw === null) return null;
            value = JSON.parse(raw);
        } catch (e) {
            return null;    // storage blocked, or not JSON
        }
        if (typeof value === 'number') return TIERS.includes(value) ? value : null;
        if (!value || typeof value !== 'object' || !TIERS.includes(value.tier)) return null;
        const age = Number.isFinite(value.at) ? Date.now() - value.at : NaN;
        if (!(age <= TIER_STORED_MAX_AGE_MS && age >= -TIER_STORED_MAX_AHEAD_MS)) return null;
        return value.tier;
    }

    _storeTier(tier) {
        if (!this._tierKey || !this._storage) return;
        try {
            this._storage.setItem(TIER_STORAGE_PREFIX + this._tierKey,
                                  JSON.stringify({ tier, at: Date.now() }));
        } catch (e) { /* storage blocked: the tier still applies */ }
    }

    // The tier the session now offers: logged, reported, and stored — at
    // once if higher, once it has streamed TIER_PERSIST_DOWN_MS if lower.
    _adoptTier(tier, reason) {
        if (tier === this.tier) return;
        this._warn('tier ' + this.tier + ' -> ' + tier + ' kbit/s (' + reason + ')');
        const down = tier < this.tier;
        this.tier = tier;
        if (down) {
            this._tierToStore = { tier, at: this._now() };
        } else {
            this._tierToStore = null;
            this._storeTier(tier);
        }
        this._onTier(tier);
    }

    // Store a lower tier once it has streamed TIER_PERSIST_DOWN_MS without
    // a break: counted from the later of the down and the stream's start,
    // and only while streaming with no re-offer out.
    _storeTierWhenProven(now) {
        const pending = this._tierToStore;
        if (!pending) return;
        if (pending.tier !== this.tier) { this._tierToStore = null; return; }
        const since = Math.max(pending.at, this._streamStartAt === null ? pending.at : this._streamStartAt);
        if (now - since < TIER_PERSIST_DOWN_MS) return;
        this._tierToStore = null;
        this._storeTier(pending.tier);
    }

    // The agent's budget from its last control frame: limiting when it
    // names a rate, not limiting when 0, and nothing when too old.
    _agentBudget(now) {
        const c = this._agentControl;
        if (!c || now - c.at > AGENT_CONTROL_MAX_AGE_MS) return null;
        return c.budgetKbit > 0 ? { kbit: c.budgetKbit, limiting: true } : { kbit: 0, limiting: false };
    }

    // One controller sample; `recovery` names the glitch being recovered
    // from, if any. Remembers what moved it, for the log.
    // Inside TIER_GRACE_MS of a stream start, loss and delay go in as
    // unknown (NaN): no down from them, and no credit toward an up.
    _sampleTier(now, recovery) {
        this._lastTierEvalAt = now;
        const w = this._recvStats.window(now);
        const grace = this._streamStartAt !== null && now - this._streamStartAt < TIER_GRACE_MS;
        if (grace) {
            w.lossPct = NaN;
            w.queueDelayMs = NaN;
        }
        const budget = this._agentBudget(now);
        const from = this._tierCtl.tier;
        const next = this._tierCtl.sample({ now, ...w, budget, recovery: !!recovery });
        if (next === null) return;
        this._tierWhy = (next < from ? 'down' : 'up') + ': ' +
            (recovery ? 'recovery from ' + recovery + ', ' : '') +
            (grace ? 'stream starting' : 'loss ' + w.lossPct.toFixed(1) + '%, delay ' +
                Math.round(w.queueDelayMs) + ' ms') + ', video ' + Math.round(w.videoKbit) + ' kbit/s, ' +
            (!budget ? 'no budget' : budget.limiting ? 'budget ' + budget.kbit + ' kbit/s' : 'budget not limiting');
    }

    // Every tick while streaming: sample on TIER_EVAL_MS, and put the
    // controller's tier into effect. A change that cannot go now is kept and
    // tried again on the next tick.
    _driveTier(now) {
        if (this.state !== 'streaming' || this._reoffering) return;
        this._storeTierWhenProven(now);
        if (this._lastTierEvalAt === null || now - this._lastTierEvalAt >= TIER_EVAL_MS) {
            this._sampleTier(now, null);
        }
        if (this._tierCtl.tier !== this.tier) this.setTier(this._tierCtl.tier, this._tierWhy || 'controller');
    }

    // A glitch while streaming: re-offer to restart the media on the open
    // connection rather than end High Performance, up to the cap. The old
    // picture stays, blurred, until the new stream has one.
    // Where the video pipeline is, for diagnosing why it stopped.
    _diagLine() {
        const a = (this._assembler && this._assembler.diag) || {};
        const ss = (this._sink && this._sink.stats) || {};
        const backlog = (this._sink && this._sink.backlog) || 0;
        return 'decrypting=' + this._decrypting + ' authFail=' + this.stats.authFailures +
            ' vpkts=' + this.stats.videoPackets + ' pics=' + this.stats.pictures +
            ' | asm buffered=' + a.buffered + ' next=' + a.next +
            ' waitingKey=' + a.waitingKey + ' ignored=' + a.ignored + ' malformed=' + a.malformed +
            ' dup=' + a.duplicates + ' emitted=' + a.emitted + ' skipped=' + a.skipped +
            ' | sink submitted=' + ss.submitted + ' decoded=' + ss.decoded +
            ' dropped=' + ss.dropped + ' backlog=' + backlog;
    }

    _streamingFail(reason, detail) {
        // A re-offer (resize or an earlier recovery) is already in flight and
        // will replace the stream; a glitch from the old one meanwhile — the
        // old assembler stalling, say — is its to resolve, not a reason to end,
        // and not worth warning about.
        if (this._reoffering) return;
        // Log the pipeline state at the moment of trouble, to show the stage.
        this._warn('glitch ' + reason + (detail ? ' (' + detail + ')' : '') + ' — ' + this._diagLine());
        const now = this._now();
        this._recoveryAt = this._recoveryAt.filter(t => now - t < RECOVERY_WINDOW_MS);
        if (RECOVERABLE.has(reason) && this.state === 'streaming' &&
            this._recoveryAt.length < RECOVERY_MAX) {
            this._recoveryAt.push(now);
            this._warn('recovering from ' + reason + (detail ? ' (' + detail + ')' : '') +
                       ', attempt ' + this._recoveryAt.length + ' of ' + RECOVERY_MAX);
            this._overloadedSince = null;   // give the fresh stream a clean slate
            // A recovery is a down trigger: its re-offer asks for the
            // controller's tier (one lower, unless a down was just made).
            this._sampleTier(now, reason);
            this._adoptTier(this._tierCtl.tier, this._tierWhy || 'recovery from ' + reason);
            this._reoffer('recovery');
            return;
        }
        this._fail(reason, detail);
    }

    // A re-offer is in flight: a second one must wait for it.
    reoffering() {
        return this._reoffering;
    }

    _endReoffer() {
        this._reoffering = false;
        this._reofferKind = null;
        this._pendingSecrets = null;
    }

    // The resize is over, by a new picture or by giving up: clear the dim.
    _resizeDone() {
        if (this._resizeSignalled) { this._resizeSignalled = false; this._onResize(false); }
    }

    // The server's answer to a resize re-offer: build the new stream and put
    // it in place. The old sink stays until the new one has a picture.
    async _swapMedia(payload) {
        const answer = await parseAnswer(payload);
        const secrets = this._pendingSecrets;
        if (!secrets) { this._endReoffer(); this._resizeDone(); return; }
        const audio = splitKeyBlock(secrets.audioKeys);
        const video = splitKeyBlock(secrets.videoKeys);
        const ctx = {
            audioIn: await createContext(audio.fromServer.key, audio.fromServer.salt),
            audioOut: await createContext(audio.toServer.key, audio.toServer.salt),
            videoIn: await createContext(video.fromServer.key, video.fromServer.salt),
            videoOut: await createContext(video.toServer.key, video.toServer.salt),
        };
        if (!this._reoffering || this.state !== 'streaming') return;

        const oldSink = this._sink;
        const assembler = new VideoAssembler({
            baseSsrc: answer.video.ssrc,
            stripes: answer.video.stripes,
            onPicture: p => this._onPicture(p),
            onNeedKey: (s) => {
                this._log('resize: waiting for picture ' + s.expectedDon);
                this._startKeyWait('waiting for picture ' + s.expectedDon);
            },
        });
        // The old picture stays, blurred, until the new size is really on
        // screen: a whole first picture painted and composited. A safety
        // timer lifts it even if that first picture never completes.
        let shown = false;
        const showNew = () => {
            if (shown) return;
            shown = true;
            clearTimeout(showTimer);
            if (oldSink && oldSink !== sink) oldSink.close();
            this._resizeOldSink = null;
            this._resizeDone();
        };
        const sink = this._createSink({
            width: answer.video.width,
            height: answer.video.height,
            stripes: answer.video.stripes,
            onFirstPicture: () => showNew(),
            onError: reason => { this._log('resize sink error: ' + reason); showNew(); },
        });
        const showTimer = this._timeout(RESIZE_SHOW_MS, () => {
            this._log('resize: first picture slow; showing anyway');
            showNew();
        });

        // From here the new keys, streams and sink are the session's.
        this._secrets = secrets;
        this._ctx = ctx;
        this._answer = answer;
        this._assembler = assembler;
        this._sink = sink;
        // The old sink is kept until the new picture shows; hold it where
        // teardown can find it, so a close() in that window frees it too.
        this._resizeOldSink = (oldSink && oldSink !== sink) ? oldSink : null;
        this._recvStats = new ReceiveStats();
        this._lastSenderReport = [null, null];
        // The new stream starts now: give the silence watchdogs a fresh
        // window so the gap of the mode switch does not trip them.
        this._lastMediaAt = this._now();
        this._lastVideoPacketAt = this._now();
        this._videoFlowSince = this._now();
        this._lastPictureAt = this._now();
        this._streamStartAt = this._now();
        // Its first-key timer starts from its own first video packet.
        this._streamVideoAt = null;
        this._streamKeySeen = false;
        // The audio stream restarts with a new SSRC and sequence; let its
        // reorder take the new numbers, or every packet reads as late.
        if (this._audio && this._audio.resetStream) this._audio.resetStream();
        const kind = this._reofferKind;
        this._endReoffer();
        this._log((kind === 'resize' ? 'resized to ' : kind + ' re-offer answered: ') +
                  answer.video.width + 'x' + answer.video.height +
                  ', ' + answer.video.stripes + ' stripes, tier ' + this.tier + ' kbit/s');
    }

    async _startMedia(payload) {
        const answer = await parseAnswer(payload);
        const audio = splitKeyBlock(this._secrets.audioKeys);
        const video = splitKeyBlock(this._secrets.videoKeys);
        const ctx = {
            audioIn: await createContext(audio.fromServer.key, audio.fromServer.salt),
            audioOut: await createContext(audio.toServer.key, audio.toServer.salt),
            videoIn: await createContext(video.fromServer.key, video.fromServer.salt),
            videoOut: await createContext(video.toServer.key, video.toServer.salt),
        };
        if (this.state !== 'offering') return;

        this._answer = answer;
        this._ctx = ctx;
        this._assembler = new VideoAssembler({
            baseSsrc: answer.video.ssrc,
            stripes: answer.video.stripes,
            onPicture: p => this._onPicture(p),
            onNeedKey: s => this._startKeyWait('waiting for picture ' + s.expectedDon),
        });
        this._sink = this._createSink({
            width: answer.video.width,
            height: answer.video.height,
            stripes: answer.video.stripes,
            onFirstFrame: () => {
                if (this.state === 'waiting') {
                    this._lastPictureAt = this._now();
                    this._streamStartAt = this._lastPictureAt;
                    this._setState('streaming');
                }
            },
            onError: reason => this._fail('decoder', reason),
        });
        this._log('answer: ' + answer.video.width + 'x' + answer.video.height +
                  ', ' + answer.video.stripes + ' stripes');
        this._setState('waiting');

        // Sound is a bonus: the picture does not wait for it, and its
        // failure is not the session's.
        if (this._createAudio) {
            Promise.resolve().then(() => this._createAudio()).then((audio) => {
                if (this._torn) audio.close();
                else {
                    this._audio = audio;
                    if (audio.setMuted) audio.setMuted(this._audioMuted);
                    this._log('audio ready');
                }
            }, e => this._log('no audio: ' + (e && e.message ? e.message : e)));
        }

        // Datagrams that arrived while the keys were being derived.
        const early = this._early || [];
        this._early = null;
        for (const { data, at } of early) this._onMedia(data, at);

        this._timeout(FIRST_FRAME_MS, () => {
            if (this.state === 'waiting') this._fail('no-picture');
        });
        this._interval(RATE_CONTROL_MS, () => this._tick());
        this._interval(REPORT_MS, () => this._sendReports());
    }

    // ----- media in -----

    // `arrivedAt`: when the datagram came in, before any work on it here;
    // the receive stats time packets by it, so a decryption backlog is not
    // mistaken for a queue on the path.
    _onMedia(data, arrivedAt = this._now()) {
        if (!this._loggedRecv) { this._loggedRecv = true; this._log('HP first media RECV bytes=' + (data.byteLength || data.length)); }
        if (this.state === 'failed' || this.state === 'closed') return;
        const bytes = new Uint8Array(data);
        // The agent's control frame is not media: it never reaches the
        // decryption, and it is no sign that the server is still sending.
        if (bytes.length > 0 && bytes[0] === CHANNEL_CONTROL) {
            this._onAgentControl(bytes);
            return;
        }
        if (!this._ctx) {
            // The server may start before our keys are ready.
            if (this.state === 'offering') {
                (this._early = this._early || []).push({ data, at: arrivedAt });
                if (this._early.length > 4096) this._early.shift();
            }
            return;
        }
        if (bytes.length < 13) return;
        const channel = bytes[0];
        const packet = bytes.subarray(1);
        if (channel !== CHANNEL_AUDIO && channel !== CHANNEL_VIDEO) return;
        const now = arrivedAt;
        const ctx = channel === CHANNEL_VIDEO ? this._ctx.videoIn : this._ctx.audioIn;

        if (isRtcp(packet)) {
            ctx.unprotectRtcp(packet).then((plain) => {
                if (!plain) { this.stats.authFailures++; return; }
                this.stats.rtcpPackets++;
                // Sender report: remember its NTP time for our next report.
                if (plain[1] === 200 && plain.length >= 16) {
                    const middle = ((plain[10] << 24) | (plain[11] << 16) | (plain[12] << 8) | plain[13]) >>> 0;
                    this._lastSenderReport[channel] = { middle, at: now };
                }
            }, () => { this.stats.authFailures++; });
            return;
        }

        this._decrypting++;
        ctx.unprotectRtp(packet).then((rtp) => {
            this._decrypting--;
            if (!rtp) { this.stats.authFailures++; return; }
            if (this.state === 'failed' || this.state === 'closed') return;
            this._lastMediaAt = this._now();
            if (channel === CHANNEL_AUDIO) {
                this.stats.audioPackets++;
                this.stats.audioBytes += rtp.payload.length;
                this._recvStats.onPacket({
                    ssrc: rtp.ssrc, seq: rtp.seq, rtpTs: rtp.timestamp, clockRate: AUDIO_CLOCK,
                    bytes: rtp.payload.length, now, video: false,
                });
                if (this._audio) this._audio.push(rtp);
                return;
            }
            if (rtp.payloadType !== PAYLOAD_TYPE_HEVC) {
                // The offer lists a second video format because Apple's does;
                // this viewer reads HEVC only.
                this._fail('unsupported-video', 'payload type ' + rtp.payloadType);
                return;
            }
            this.stats.videoPackets++;
            this.stats.videoBytes += rtp.payload.length;
            const at = this._now();
            if (this._lastVideoPacketAt === null || at - this._lastVideoPacketAt >= VIDEO_GAP_MS) {
                this._videoFlowSince = at;
            }
            this._lastVideoPacketAt = at;
            // Only the current stream's own stripes start its first-key timer.
            const video = this._answer.video;
            if (this._streamVideoAt === null && ((rtp.ssrc - video.ssrc) >>> 0) < video.stripes) {
                this._streamVideoAt = now;
            }
            this._recvStats.onPacket({
                ssrc: rtp.ssrc, seq: rtp.seq, rtpTs: rtp.timestamp, clockRate: VIDEO_CLOCK,
                bytes: rtp.payload.length, now, video: true,
            });
            this._assembler.push(rtp, this._now());
        }, () => {
            this._decrypting--;
            this.stats.authFailures++;
        });
    }

    _onAgentControl(bytes) {
        this.stats.controlFrames++;
        const frame = parseAgentControl(bytes);
        if (!frame) {
            this.stats.controlRejected++;
            return;
        }
        if (!this._agentControl) {
            this._log('agent control: budget ' + frame.budgetKbit + ' kbit/s, queue ' + frame.queueMs +
                      ' ms, rtt ' + frame.rttMs + ' ms, loss ' + frame.lossPermille + '‰');
        }
        this._agentControl = Object.assign({ at: this._now() }, frame);
    }

    _onPicture(picture) {
        this.stats.pictures++;
        this._lastPictureAt = this._now();
        if (picture.key) {
            this.stats.keyPictures++;
            this._streamKeySeen = true;
            const w = this._keyWait;
            if (w) {
                this._keyWait = null;
                this.stats.keyAnswered++;
                this._warn('key picture after ' + Math.round(this._now() - w.at) + ' ms, ' +
                           w.requests + ' request(s) (' + w.reason + ')');
            }
        }
        if (this._sink) this._sink.push(picture);
        if (this._feedback.acks) {
            this._sendRtcp(CHANNEL_VIDEO, pictureAck({
                ssrc: this._secrets.videoSsrc,
                don: picture.don & 0xffff,
            }));
        }
    }

    // ----- key pictures -----

    // Ask the Mac for a key picture: a PLI now, then by turns a FIR and a
    // PLI every KEY_RETRY_MS (_driveKeyWait) until one comes. Also before
    // the first picture (a stream whose first key picture was lost). Not
    // while a re-offer is out: the stream that answers it starts with one.
    _keyWaitAllowed() {
        return (this.state === 'streaming' || this.state === 'waiting') && !this._reoffering;
    }

    _startKeyWait(reason) {
        if (!this._keyWaitAllowed() || this._keyWait) return;
        this.stats.keyWaits++;
        this._keyWait = { reason, at: this._now(), requests: 0, retries: 0 };
        this._warn('requesting key picture (' + reason + ')');
        this._requestKey(false);
    }

    // One request, alone (not compound), naming the current stream's video
    // SSRC, on the video channel.
    _requestKey(useFir) {
        const ids = { ssrc: this._secrets.videoSsrc, mediaSsrc: this._answer.video.ssrc };
        let packet;
        if (useFir) {
            this._firSeq = (this._firSeq + 1) & 0xff;
            packet = fir({ ...ids, seq: this._firSeq });
        } else {
            packet = pli(ids);
        }
        this._keyWait.requests++;
        this.stats.keyRequests++;
        this._sendRtcp(CHANNEL_VIDEO, packet);
    }

    // Every tick: start a wait for a stream that needs a key picture and is
    // not being asked (the assembler is waiting, or the stream has had none
    // KEY_FIRST_MS after its first video packet); ask again on KEY_RETRY_MS;
    // give up after KEY_WAIT_MS with a recovery. An answered wait is no tier
    // trigger: a tier change restarts the stream and would undo the repair.
    // Before the first picture there is no giving up here: FIRST_FRAME_MS
    // is the limit. A wait that began then and is still running once
    // streaming gives up by the time it began.
    _driveKeyWait(now) {
        if (!this._keyWaitAllowed()) return;
        const w = this._keyWait;
        if (!w) {
            if (this._assembler && this._assembler.waitingForKey) {
                this._startKeyWait('waiting for picture ' + this._assembler.diag.next);
            } else if (this._streamVideoAt !== null && !this._streamKeySeen &&
                       now - this._streamVideoAt >= KEY_FIRST_MS) {
                this._startKeyWait('no key picture yet');
            }
            return;
        }
        const elapsed = now - w.at;
        if (elapsed >= KEY_WAIT_MS && this.state === 'streaming') {
            this._keyWait = null;
            this._streamingFail('stalled', 'no key picture');
            return;
        }
        const due = Math.floor(elapsed / KEY_RETRY_MS);
        if (due > w.retries) {
            w.retries = due;
            this._requestKey(due % 2 === 1);
        }
    }

    // ----- media out -----

    // Packets on one channel are protected and sent strictly in order, so
    // the SRTCP index on the wire never goes backwards.
    _sendRtcp(channel, plain) {
        const ctx = channel === CHANNEL_VIDEO ? this._ctx.videoOut : this._ctx.audioOut;
        this._sendChain[channel] = this._sendChain[channel].then(async () => {
            const packet = await ctx.protectRtcp(plain);
            if (!this._ws || !this._wsOpen) return;
            const msg = new Uint8Array(packet.length + 1);
            msg[0] = channel;
            msg.set(packet, 1);
            if (this.stats.sent === 0) this._log('HP first media SENT ch=' + channel + ' bytes=' + msg.length);
            this._ws.send(msg);
            this.stats.sent++;
        }).catch(() => {});
    }

    // End the session when the machine has been behind for too long.
    _checkLoad(now) {
        if (this._reoffering) { this._overloadedSince = null; return; }
        const backlog = (this._sink && this._sink.backlog) || 0;
        if (backlog <= OVERLOAD_PICTURES && this._decrypting <= OVERLOAD_PACKETS) {
            this._overloadedSince = null;
        } else if (this._overloadedSince === null) {
            this._overloadedSince = now;
        } else if (now - this._overloadedSince >= OVERLOAD_MS) {
            this._streamingFail('overloaded', backlog + ' pictures and ' + this._decrypting + ' packets behind');
        }
    }

    _tick() {
        const now = this._now();
        if (this._assembler) this._assembler.tick(now);
        this._checkLoad(now);
        // A re-offer (resize) makes the server stop its media, reconfigure
        // the display and start again; that gap is not the server going
        // away, so the silence watchdog pauses until the new stream is in.
        if (this.state === 'streaming' && !this._reoffering && this._lastMediaAt !== null &&
            now - this._lastMediaAt > MEDIA_SILENCE_MS) {
            this._streamingFail('media-stopped');
        }
        // Video still coming but no finished picture for a while: frozen.
        // Counted from the later of the last picture and the start of the
        // current flow, so a still screen that changes is not one.
        if (this.state === 'streaming' && !this._reoffering && !this._keyWait &&
            this._lastPictureAt !== null && this._videoFlowSince !== null &&
            now - Math.max(this._lastPictureAt, this._videoFlowSince) > PICTURE_STALL_MS &&
            this._lastVideoPacketAt !== null && now - this._lastVideoPacketAt < PICTURE_STALL_MS) {
            this._streamingFail('stalled', 'no new picture');
        }
        this._driveKeyWait(now);
        this._driveTier(now);
        if (!this._feedback.rateControl || this.state === 'failed') return;
        const sinceLast = this._lastVideoPacketAt === null ? 0 : now - this._lastVideoPacketAt;
        // Field D is the tier asked for (the Mac does not act on it).
        this._sendRtcp(CHANNEL_VIDEO, rateControl({
            ssrc: this._secrets.videoSsrc,
            a: this.stats.pictures & 0xffff,
            b: sinceLast,
            c: this.stats.videoPackets,
            d: this.tier,
        }));
    }

    _sendReports() {
        if (!this._feedback.reports) return;
        const now = this._now();
        // The report names `sourceSsrc` (as Apple's viewer does) but counts
        // loss over `lossSsrcs`: the video's other stripes would otherwise
        // never be reported.
        const report = (channel, ssrc, sourceSsrc, lossSsrcs = [sourceSsrc]) => {
            const fields = this._recvStats.rrFields(sourceSsrc, lossSsrcs);
            if (!fields) return;
            const sr = this._lastSenderReport[channel];
            this._sendRtcp(channel, receiverReport({
                ssrc,
                sourceSsrc,
                ...fields,
                lsr: sr ? sr.middle : 0,
                dlsr: sr ? Math.round((now - sr.at) * 65.536) : 0,
            }));
        };
        report(CHANNEL_AUDIO, this._secrets.audioSsrc, this._answer.audio.ssrc);
        const { ssrc: base, stripes } = this._answer.video;
        report(CHANNEL_VIDEO, this._secrets.videoSsrc, base,
            Array.from({ length: Math.max(1, stripes) }, (_, i) => base + i));
    }
}
