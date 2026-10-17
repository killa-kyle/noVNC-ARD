/*
 * Receiver-side bandwidth estimator for ARD High Performance.
 *
 * ARD HP carries a rate-control back-channel: the viewer's RTCP APP packet
 * ("RCTL") field D is a bandwidth estimate in kbit/s, and screensharingd
 * encodes its HEVC stream at a bitrate bounded by D. A constant D tells the
 * Mac to encode at a fixed rate regardless of whether the transport can carry
 * it; on a thin rung (QUIC datagrams especially) a keyframe burst at the
 * ceiling overruns the send path and the browser loses pictures.
 *
 * This controller makes D adaptive with a loss-based AIMD rule, driven off the
 * one clean loss signal the receiver already has: the assembler's cumulative
 * `skipped` count (pictures dropped by a resync forward past a missing one).
 * It starts at the ceiling, so a healthy rung with headroom never sees loss
 * and holds the current constant behaviour; only a congesting path ramps down.
 *
 * Pure: no I/O, no timer. HpSession owns one and calls sample() on a slow eval
 * cadence, reading estimate() into every report.
 */

export const MIN_KBIT = 4000;    // floor: enough for low-motion; never starve the encoder
export const MAX_KBIT = 60000;   // ceiling: the protocol's idle value (the old constant)
export const BETA = 0.85;        // multiplicative decrease on loss
export const STEP_KBIT = 3000;   // additive increase when clean
export const EVAL_MS = 300;      // how often sample() adjusts (reports still send every 50ms)

export class RateController {
    constructor() {
        this._kbit = MAX_KBIT;
        this._lastSkipped = 0;
    }

    // Called on each eval tick. `skipped` is the assembler's cumulative
    // resync-drop count (monotonic within one stream); `videoFlowing` is true
    // when video pictures are arriving.
    sample({ skipped, videoFlowing }) {
        if (!videoFlowing) {
            // Idle or audio-only: no video to lose, so hold the ceiling the way
            // the real viewer does. Track skipped so motion resuming is clean.
            this._kbit = MAX_KBIT;
            this._lastSkipped = skipped;
            return;
        }
        const lost = skipped > this._lastSkipped;
        this._lastSkipped = skipped;
        if (lost) {
            this._kbit = Math.max(MIN_KBIT, Math.round(this._kbit * BETA));
        } else {
            this._kbit = Math.min(MAX_KBIT, this._kbit + STEP_KBIT);
        }
    }

    estimate() { return this._kbit; }

    // A re-offer or resize reconfigures the stream and rebuilds the assembler
    // (restarting `skipped` at 0) — drop history and re-probe from the ceiling.
    reset() {
        this._kbit = MAX_KBIT;
        this._lastSkipped = 0;
    }
}
