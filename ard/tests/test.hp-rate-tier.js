import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TierController, DOWN_MIN_GAP_MS } from '../hp/rate-tier.js';

const GOOD = { lossPct: 0, queueDelayMs: 0, videoKbit: 20000, budget: null, recovery: false };

// Feed `seconds` one-second samples starting after `t`; returns {t, changes}.
function run(c, t, seconds, over = {}, step = 1000) {
    const changes = [];
    for (let i = 0; i < seconds * 1000 / step; i++) {
        t += step;
        const r = c.sample({ now: t, ...GOOD, ...over });
        if (r !== null) changes.push(r);
    }
    return { t, changes };
}

describe('HP tier controller', () => {
    it('starts at 16000 and caps the start by maxKbit', () => {
        assert.equal(new TierController({}).tier, 16000);
        assert.equal(new TierController({ maxKbit: 9000 }).tier, 8000);
    });

    it('steps down on loss, delay and recovery to 0.75 x tier', () => {
        for (const over of [{ lossPct: 4 }, { queueDelayMs: 200 }, { recovery: true }]) {
            const c = new TierController({});
            assert.equal(c.sample({ now: 1000, ...GOOD, ...over }), 12000);
            assert.equal(c.tier, 12000);
        }
    });

    it('a limiting budget lowers the target to 0.85 x budget', () => {
        const c = new TierController({});
        assert.equal(c.sample({ now: 1000, ...GOOD, budget: { kbit: 9000, limiting: true } }), 6000);
    });

    it('ignores a non-limiting budget', () => {
        const c = new TierController({});
        assert.equal(c.sample({ now: 1000, ...GOOD, budget: { kbit: 2000, limiting: false } }), null);
        assert.equal(c.tier, 16000);
    });

    it('a limiting budget above 0.9 x tier is no trigger', () => {
        const c = new TierController({});
        assert.equal(c.sample({ now: 1000, ...GOOD, budget: { kbit: 15000, limiting: true } }), null);
    });

    it('allows one down per 4 s', () => {
        const c = new TierController({});
        assert.equal(c.sample({ now: 1000, ...GOOD, lossPct: 5 }), 12000);
        assert.equal(c.sample({ now: 1000 + DOWN_MIN_GAP_MS - 1, ...GOOD, lossPct: 5 }), null);
        assert.equal(c.sample({ now: 1000 + DOWN_MIN_GAP_MS, ...GOOD, lossPct: 5 }), 8000);
    });

    it('steps up one tier after 30 s clean under load', () => {
        const c = new TierController({});
        const { changes } = run(c, 0, 31);
        assert.deepEqual(changes, [20000]);
    });

    it('does not count time between sparse samples as continuous 1 Hz', () => {
        const c = new TierController({});
        // 5 s cadence, 40 s: loaded the whole time, still goes up once.
        assert.deepEqual(run(c, 0, 40, {}, 5000).changes, [20000]);
    });

    it('never raises the tier on an idle screen', () => {
        const c = new TierController({});
        assert.deepEqual(run(c, 0, 120, { videoKbit: 500 }).changes, []);
    });

    it('needs 20 loaded seconds, not just 30 clean ones', () => {
        const c = new TierController({});
        let r = run(c, 0, 15, { videoKbit: 500 });
        r = run(c, r.t, 19);
        assert.deepEqual(r.changes, []);
        r = run(c, r.t, 2);
        assert.deepEqual(r.changes, [20000]);
    });

    it('loss of 1% or more restarts the clean window', () => {
        const c = new TierController({});
        let r = run(c, 0, 25);
        r = run(c, r.t, 1, { lossPct: 1.5 });
        r = run(c, r.t, 25);
        assert.deepEqual(r.changes, []);
    });

    it('is blocked by a limiting budget under 1.4 x the next tier', () => {
        const c = new TierController({});
        const lim = { kbit: 20000, limiting: true }; // < 1.4 * 20000
        assert.deepEqual(run(c, 0, 120, { budget: lim }).changes, []);
        const ok = { kbit: 30000, limiting: true };
        assert.deepEqual(run(c, 120000, 5, { budget: ok }).changes, [20000]);
    });

    it('doubles the hold after each down, capped at 120 s', () => {
        const c = new TierController({ start: 20000 });
        let r = { t: 0 };
        const down = (from, to) => {
            r = run(c, r.t, 1, { lossPct: 5 });
            assert.equal(c.tier, to, `down from ${from}`);
        };
        down(20000, 12000);
        r = run(c, r.t, 55);
        assert.equal(c.tier, 12000);
        r = run(c, r.t, 10);
        assert.equal(c.tier, 16000);
        down(16000, 12000);
        r = run(c, r.t, 115);
        assert.equal(c.tier, 12000);
        r = run(c, r.t, 10);
        assert.equal(c.tier, 16000);
        down(16000, 12000);
        r = run(c, r.t, 115);
        assert.equal(c.tier, 12000);
        r = run(c, r.t, 10);
        assert.equal(c.tier, 16000);
    });

    it('resets the hold to 30 s after 10 clean minutes', () => {
        const c = new TierController({ start: 8000 });
        let r = run(c, 0, 1, { lossPct: 5 });
        assert.equal(c.tier, 6000);
        // Loaded but blocked by a limiting budget for 10+ minutes.
        r = run(c, r.t, 601, { budget: { kbit: 9000, limiting: true } });
        assert.equal(c.tier, 6000);
        r = run(c, r.t, 21);
        assert.equal(c.tier, 8000);
        r = run(c, r.t, 31);
        assert.equal(c.tier, 10000);
    });

    it('never exceeds the ceiling or maxKbit and never drops below 4000', () => {
        const c = new TierController({ maxKbit: 12000 });
        assert.equal(c.tier, 12000);
        assert.deepEqual(run(c, 0, 200, { videoKbit: 12000 }).changes, []);
        const d = new TierController({ start: 4000 });
        assert.equal(d.sample({ now: 1000, ...GOOD, lossPct: 9 }), null);
        assert.equal(d.tier, 4000);
        const e = new TierController({});
        e.sample({ now: 1000, ...GOOD, budget: { kbit: 100, limiting: true } });
        assert.equal(e.tier, 4000);
    });
});
