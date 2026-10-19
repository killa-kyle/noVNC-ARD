/*
 * Unit tests for receive statistics: the loss, jitter and queuing delay a
 * receiver report and the tier controller are built from.
 *
 * Run: node --test ard/tests/test.hp-receive-stats.js
 */

import { describe, it } from 'node:test';
import { strictEqual, ok } from 'node:assert';

import { ReceiveStats } from '../hp/receive-stats.js';

const VIDEO = 90000;
const SSRC = 0x1234;

// Feed `count` packets from `first`, `stepMs` apart, skipping `missing`.
function feed(stats, { first = 0, count, missing = [], t0 = 0, stepMs = 10, ssrc = SSRC,
                       clockRate = VIDEO, bytes = 1000, video = true, extraMs = () => 0 }) {
    for (let i = first; i < first + count; i++) {
        if (missing.includes(i)) continue;
        stats.onPacket({
            ssrc, seq: i & 0xffff, rtpTs: ((i * stepMs * clockRate) / 1000) >>> 0, clockRate, bytes,
            now: t0 + i * stepMs + extraMs(i), video,
        });
    }
}

describe('ReceiveStats receiver report fields', () => {
    it('counts missing packets and the fraction since the previous report', () => {
        const stats = new ReceiveStats();
        feed(stats, { count: 100, missing: [10, 11, 12, 13, 14] });
        const a = stats.rrFields(SSRC);
        strictEqual(a.cumulativeLost, 5);
        strictEqual(a.fractionLost, Math.floor(5 * 256 / 100));
        strictEqual(a.highestSeq, 99);
        feed(stats, { first: 100, count: 100 });
        const b = stats.rrFields(SSRC);
        strictEqual(b.fractionLost, 0);
        strictEqual(b.cumulativeLost, 5);
        strictEqual(b.highestSeq, 199);
    });

    it('knows nothing of a stream it has not seen', () => {
        strictEqual(new ReceiveStats().rrFields(SSRC), null);
    });

    it('counts no loss across sequence wraparound and extends the highest', () => {
        const stats = new ReceiveStats();
        for (let i = 0; i < 12; i++) {
            stats.onPacket({ ssrc: SSRC, seq: (65530 + i) & 0xffff, rtpTs: i * 900, clockRate: VIDEO,
                             bytes: 100, now: i * 10, video: true });
        }
        const r = stats.rrFields(SSRC);
        strictEqual(r.cumulativeLost, 0);
        strictEqual(r.fractionLost, 0);
        strictEqual(r.highestSeq, 65530 + 11);
    });

    it('does not count a late or duplicate packet as a new loss', () => {
        const stats = new ReceiveStats();
        const p = (seq, now) => stats.onPacket({ ssrc: SSRC, seq, rtpTs: seq * 900, clockRate: VIDEO,
                                                 bytes: 1, now, video: true });
        p(0, 0); p(1, 10); p(3, 30); p(2, 35); p(2, 36); p(4, 40);
        const r = stats.rrFields(SSRC);
        strictEqual(r.highestSeq, 4);
        strictEqual(r.cumulativeLost, 0);
    });

    it('computes interarrival jitter by RFC 3550 section 6.4.1', () => {
        const stats = new ReceiveStats();
        const extra = (i) => (i % 2 ? 2 : 0);
        feed(stats, { count: 200, extraMs: extra });
        let jitter = 0, prev = null;
        for (let i = 0; i < 200; i++) {
            const transit = (i * 10 + extra(i)) * VIDEO / 1000 - i * 900;
            if (prev !== null) jitter += (Math.abs(transit - prev) - jitter) / 16;
            prev = transit;
        }
        strictEqual(stats.rrFields(SSRC).jitter, Math.floor(jitter));
        ok(jitter > 100, 'a 2 ms swing is 180 units, got ' + jitter);
    });

    it('keeps each SSRC apart', () => {
        const stats = new ReceiveStats();
        feed(stats, { count: 50, ssrc: 1, missing: [3] });
        feed(stats, { count: 50, ssrc: 2, clockRate: 48000, video: false });
        strictEqual(stats.rrFields(1).cumulativeLost, 1);
        strictEqual(stats.rrFields(2).cumulativeLost, 0);
    });
});

describe('ReceiveStats window', () => {
    it('reports loss across all video SSRCs, not audio', () => {
        const stats = new ReceiveStats();
        feed(stats, { count: 100, missing: [20, 50, 80], stepMs: 15 });
        feed(stats, { count: 100, ssrc: 0x99, clockRate: 48000, video: false, missing: [5, 6, 7, 8] });
        const w = stats.window(1500);
        strictEqual(w.lossPct, 3);
    });

    it('sums loss over two stripes', () => {
        const stats = new ReceiveStats();
        feed(stats, { count: 100, ssrc: 1, stepMs: 15 });
        feed(stats, { count: 100, ssrc: 2, stepMs: 15, missing: [10, 11, 12, 13, 14, 15, 16, 17, 18, 19] });
        const w = stats.window(1500);
        strictEqual(w.lossPct, 5);
    });

    it('forgets packets older than two seconds', () => {
        const stats = new ReceiveStats();
        feed(stats, { count: 100, missing: [30, 31], stepMs: 10 });
        ok(stats.window(1000).lossPct > 0);
        strictEqual(stats.window(5000).lossPct, 0);
        strictEqual(stats.window(5000).videoKbit, 0);
    });

    it('reads queuing delay above the 10 s baseline', () => {
        const stats = new ReceiveStats();
        feed(stats, { count: 1000, stepMs: 10, extraMs: () => 30 });   // 10 s at a steady 30 ms transit
        feed(stats, { first: 1000, count: 1, stepMs: 10, extraMs: () => 230 });
        const w = stats.window(10010 + 230);
        ok(Math.abs(w.queueDelayMs - 200) < 1, 'about 200, got ' + w.queueDelayMs);
        strictEqual(stats.window(20000).queueDelayMs, 0);
    });

    it('is not fooled by the 32-bit timestamp wrapping', () => {
        const stats = new ReceiveStats();
        for (let i = 0; i < 100; i++) {
            stats.onPacket({ ssrc: SSRC, seq: i, rtpTs: (0xffffff00 + i * 900) >>> 0, clockRate: VIDEO,
                             bytes: 10, now: i * 10, video: true });
        }
        ok(stats.window(1000).queueDelayMs < 1);
    });

    it('measures video bit rate from bytes over the window', () => {
        const stats = new ReceiveStats();
        feed(stats, { count: 300, stepMs: 10, bytes: 1250 });     // 1000 kbit/s for 3 s
        const w = stats.window(2990);
        ok(Math.abs(w.videoKbit - 1000) < 20, 'about 1000, got ' + w.videoKbit);
    });
});
