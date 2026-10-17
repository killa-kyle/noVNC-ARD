/*
 * Unit tests for the HP receiver-side bandwidth estimator.
 *
 * The estimator drives field D of the rate-control report: a loss-based AIMD
 * loop that starts at the ceiling, multiplicatively backs off when the
 * assembler drops a picture, and additively probes back up when it does not.
 * All data here is synthetic.
 *
 * Run: node --test ard/tests/test.hp-rate-control.js
 */

import { describe, it } from 'node:test';
import { strictEqual, ok } from 'node:assert';

import {
    RateController,
    MIN_KBIT, MAX_KBIT, BETA, STEP_KBIT,
} from '../hp/rate-control.js';

describe('HP rate controller', () => {
    it('starts at the ceiling', () => {
        const rc = new RateController();
        strictEqual(rc.estimate(), MAX_KBIT);
    });

    it('backs off multiplicatively when the assembler skips a picture', () => {
        const rc = new RateController();
        rc.sample({ skipped: 1, videoFlowing: true });
        strictEqual(rc.estimate(), Math.round(MAX_KBIT * BETA));
    });

    it('treats only a GROWING skipped count as loss, equal count as clean', () => {
        const rc = new RateController();
        rc.sample({ skipped: 3, videoFlowing: true });   // loss: 3 > 0
        const afterLoss = rc.estimate();
        rc.sample({ skipped: 3, videoFlowing: true });   // clean: 3 not > 3
        strictEqual(rc.estimate(), Math.min(MAX_KBIT, afterLoss + STEP_KBIT));
    });

    it('probes upward additively when there is no new loss', () => {
        const rc = new RateController();
        rc.sample({ skipped: 1, videoFlowing: true });   // drop below ceiling first
        const low = rc.estimate();
        ok(low < MAX_KBIT);
        rc.sample({ skipped: 1, videoFlowing: true });   // clean
        strictEqual(rc.estimate(), Math.min(MAX_KBIT, low + STEP_KBIT));
    });

    it('holds the ceiling while video is idle, whatever skipped reads', () => {
        const rc = new RateController();
        rc.sample({ skipped: 1, videoFlowing: true });   // drop below ceiling
        ok(rc.estimate() < MAX_KBIT);
        rc.sample({ skipped: 999, videoFlowing: false }); // idle: no video to lose
        strictEqual(rc.estimate(), MAX_KBIT);
    });

    it('never ramps below the floor under sustained loss', () => {
        const rc = new RateController();
        let skipped = 0;
        for (let i = 0; i < 100; i++) {
            skipped += 1;
            rc.sample({ skipped, videoFlowing: true });
            ok(rc.estimate() >= MIN_KBIT, 'estimate ' + rc.estimate() + ' below floor');
        }
        strictEqual(rc.estimate(), MIN_KBIT);
    });

    it('never ramps above the ceiling under sustained clean', () => {
        const rc = new RateController();
        for (let i = 0; i < 100; i++) {
            rc.sample({ skipped: 0, videoFlowing: true });
            ok(rc.estimate() <= MAX_KBIT, 'estimate ' + rc.estimate() + ' above ceiling');
        }
        strictEqual(rc.estimate(), MAX_KBIT);
    });

    it('recovers upward after loss stops', () => {
        const rc = new RateController();
        let skipped = 0;
        for (let i = 0; i < 5; i++) { skipped += 1; rc.sample({ skipped, videoFlowing: true }); }
        const low = rc.estimate();
        ok(low < MAX_KBIT);
        // Loss stops: skipped holds steady, estimate climbs back.
        for (let i = 0; i < 50; i++) rc.sample({ skipped, videoFlowing: true });
        strictEqual(rc.estimate(), MAX_KBIT);
        ok(rc.estimate() > low);
    });

    it('reset returns to the ceiling and does not infer loss from a restarted skipped count', () => {
        const rc = new RateController();
        let skipped = 0;
        for (let i = 0; i < 5; i++) { skipped += 1; rc.sample({ skipped, videoFlowing: true }); }
        ok(rc.estimate() < MAX_KBIT);
        rc.reset();
        strictEqual(rc.estimate(), MAX_KBIT);
        // A rebuilt assembler restarts skipped at 0; the first sample must not
        // read 0 < 5 as loss (it is a clean count, so the estimate holds MAX).
        rc.sample({ skipped: 0, videoFlowing: true });
        strictEqual(rc.estimate(), MAX_KBIT);
    });
});
