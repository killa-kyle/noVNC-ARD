/*
 * High Performance mode — what the receiver has measured of the incoming
 * streams.
 *
 * Two readers use it. Receiver reports (RFC 3550 section 6.4.1) say, per
 * stream, how much was lost and how much the arrival times jitter;
 * rrFields() produces exactly those fields. The tier controller wants the
 * same facts for the video as a whole over the last moments: window().
 *
 * Observation is kept apart from inference: loss is counted from sequence
 * numbers, jitter follows the RFC, and queuing delay is the growth of
 * (arrival time - RTP time) over its own 10 s minimum. That last is a
 * signal that a queue is filling, not a measurement of any one hop. It is
 * taken once per picture, from the first packet of each new RTP timestamp:
 * the rest of a large picture follow at the sender's pace, and their spread
 * is serialization, not queuing. The caller passes the arrival time, taken
 * before any local work (decryption) on the packet.
 */

import { extendSeq } from './seq.js';

export const WINDOW_MS = 2000;
export const BASELINE_MS = 10000;
// The rate is bytes over the span seen, so the first packets do not read
// as a trickle; but a span of nothing would read as a flood.
const MIN_RATE_SPAN_MS = 250;
const COMPACT_AT = 1024;

// Queue with a moving head, so dropping old entries costs nothing.
class Fifo {
    constructor() {
        this.items = [];
        this.head = 0;
    }

    get length() { return this.items.length - this.head; }
    push(item) { this.items.push(item); }
    peek() { return this.items[this.head]; }
    last() { return this.items[this.items.length - 1]; }

    shift() {
        const item = this.items[this.head++];
        if (this.head >= COMPACT_AT && this.head * 2 >= this.items.length) {
            this.items = this.items.slice(this.head);
            this.head = 0;
        }
        return item;
    }

    pop() {
        if (this.length > 0) this.items.pop();
    }
}

// One RTP stream, by SSRC.
class Stream {
    constructor(seq, rtpTs, clockRate, now) {
        this.clockRate = clockRate;
        this.baseSeq = seq;
        this.maxSeq = seq;
        this.received = 0;
        this.expectedPrior = 0;
        this.receivedPrior = 0;
        this.jitter = 0;
        this.prevTs = rtpTs;
        this.extTs = rtpTs;
        this.maxExtTs = null;       // newest picture (RTP time) seen
        this.firstTs = rtpTs;
        this.firstAt = now;
        this.prevArrival = null;
        this.prevTransit = null;
        // Arrival minus RTP time, smallest first; the front is the baseline.
        this.baseline = new Fifo();
    }

    // Returns how many packets the stream has moved on by (0 for a late one,
    // 1 for the first) and, for the first packet of a newer picture, its
    // queuing delay above the baseline (null for any other packet).
    add(seq, rtpTs, now) {
        const ext = extendSeq(this.maxSeq, seq);
        const first = this.received === 0;
        const advance = first ? 1 : Math.max(0, ext - this.maxSeq);
        if (advance > 0) this.maxSeq = ext;
        this.received++;

        // RFC 3550 A.8, in RTP clock units; the timestamp's 32-bit wrap is
        // taken the short way round.
        const arrival = now * this.clockRate / 1000;
        const tsStep = (rtpTs - this.prevTs) | 0;
        this.prevTs = rtpTs;
        this.extTs += tsStep;
        const transit = arrival - this.extTs;
        if (this.prevTransit !== null) {
            this.jitter += (Math.abs(transit - this.prevTransit) - this.jitter) / 16;
        }
        this.prevTransit = transit;

        if (this.maxExtTs !== null && this.extTs <= this.maxExtTs) return { advance, excess: null };
        this.maxExtTs = this.extTs;
        const rel = (now - this.firstAt) - (this.extTs - this.firstTs) * 1000 / this.clockRate;
        const q = this.baseline;
        while (q.length > 0 && q.peek().at < now - BASELINE_MS) q.shift();
        while (q.length > 0 && q.last().rel >= rel) q.pop();
        q.push({ at: now, rel });
        return { advance, excess: rel - q.peek().rel };
    }

    fields() {
        const expected = this.maxSeq - this.baseSeq + 1;
        const expectedInterval = expected - this.expectedPrior;
        const receivedInterval = this.received - this.receivedPrior;
        this.expectedPrior = expected;
        this.receivedPrior = this.received;
        const lostInterval = expectedInterval - receivedInterval;
        return {
            highestSeq: this.maxSeq,
            fractionLost: expectedInterval <= 0 || lostInterval <= 0
                ? 0 : Math.floor(lostInterval * 256 / expectedInterval),
            cumulativeLost: Math.max(0, expected - this.received),
            jitter: Math.floor(this.jitter),
        };
    }
}

export class ReceiveStats {
    constructor() {
        this._streams = new Map();
        this._window = new Fifo();
        this._videoSince = null;
    }

    /*
     * One authenticated RTP packet. `rtpTs` is the 32-bit RTP timestamp,
     * `clockRate` its units per second (90000 video, 48000 audio), `bytes`
     * the payload size, `now` the arrival time in ms, `video` whether it
     * counts toward window().
     */
    onPacket({ ssrc, seq, rtpTs, clockRate, bytes, now, video }) {
        let stream = this._streams.get(ssrc);
        if (!stream) {
            stream = new Stream(seq, rtpTs, clockRate, now);
            this._streams.set(ssrc, stream);
        }
        const { advance, excess } = stream.add(seq, rtpTs, now);
        if (!video) return;
        if (this._videoSince === null) this._videoSince = now;
        this._window.push({ at: now, bytes, expected: advance, excess });
        this._prune(now);
    }

    _prune(now) {
        const w = this._window;
        while (w.length > 0 && w.peek().at < now - WINDOW_MS) w.shift();
    }

    /*
     * Report block fields for one stream, covering the time since the
     * previous call for that stream. null if nothing has arrived on it.
     */
    rrFields(ssrc) {
        const stream = this._streams.get(ssrc);
        return stream ? stream.fields() : null;
    }

    /*
     * Video over the last WINDOW_MS: percent of packets missing, the
     * largest queuing delay in ms, and the received rate in kbit/s.
     */
    window(now) {
        this._prune(now);
        const w = this._window;
        let expected = 0, received = 0, bytes = 0, queueDelayMs = 0;
        for (let i = w.head; i < w.items.length; i++) {
            const s = w.items[i];
            expected += s.expected;
            received++;
            bytes += s.bytes;
            if (s.excess !== null && s.excess > queueDelayMs) queueDelayMs = s.excess;
        }
        const span = this._videoSince === null ? 0
            : Math.min(WINDOW_MS, Math.max(MIN_RATE_SPAN_MS, now - this._videoSince));
        return {
            lossPct: expected > received ? (expected - received) * 100 / expected : 0,
            queueDelayMs,
            videoKbit: span > 0 ? bytes * 8 / span : 0,
        };
    }
}
