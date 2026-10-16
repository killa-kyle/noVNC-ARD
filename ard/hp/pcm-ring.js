/*
 * High Performance mode — the buffer between the audio decoder and the
 * sound card.
 *
 * Decoded sound arrives in bursts as the network delivers it; the sound
 * card takes it at a fixed rate. The ring holds a small reserve so that
 * late packets do not become gaps, starts playing only once the reserve is
 * there, and throws away the oldest sound if it ever holds far too much,
 * so the delay cannot grow.
 */

export class PcmRing {
    /*
     * capacity: samples per channel the ring can hold
     * target:   reserve to build before playing, and to fall back to
     * limit:    more than this queued means the delay has grown; drop to target
     * adaptive: grow the reserve when it runs dry, shrink it back slowly,
     *           and keep the delay close to it (see _adapt); off by default,
     *           so a caller that does not ask keeps exactly the fixed
     *           reserve above
     * maxTarget, step, decayStep, decayAfter: the adaptive reserve's bounds
     * headroom: adaptive only, how far over the reserve the queue may go
     *           before it is trimmed back (replaces limit)
     * drainOver, drainAfter: adaptive only, a queue more than drainOver over
     *           the reserve for drainAfter samples played is trimmed back
     * (all in samples per channel)
     */
    constructor({
        capacity = 24000, target = 3840, limit = 12000,
        adaptive = false, maxTarget = 5760, step = 960, decayStep = 480, decayAfter = 480000,
        headroom = 2880, drainOver = 1920, drainAfter = 96000,
    } = {}) {
        this._left = new Float32Array(capacity);
        this._right = new Float32Array(capacity);
        this._capacity = capacity;
        this._target = target;
        this._limit = limit;
        this._read = 0;
        this._length = 0;
        this._playing = false;

        this._adaptive = adaptive;
        this._baseTarget = target;
        this._headroom = adaptive ? headroom : limit - target;
        if (adaptive) this._limit = target + this._headroom;
        this._maxTarget = Math.max(target, maxTarget);
        this._drainOver = drainOver;
        this._drainAfter = drainAfter;
        this._over = 0;     // samples played while the queue sat over reserve + drainOver
        this._frac = 0;         // adaptive: fractional read position (playback-rate control)
        this._pendingTrim = 0;  // adaptive: samples to skip, crossfaded in the next read
        this._fadeIn = false;   // adaptive: ramp up the next block (after a gap)
        this._step = step;
        this._decayStep = decayStep;
        this._decayAfter = decayAfter;
        this._clean = 0;    // samples played since the reserve last ran dry

        this.stats = { written: 0, played: 0, underruns: 0, dropped: 0, target };
    }

    /*
     * The adaptive reserve. A fixed reserve fails twice on one late burst:
     * it runs dry (a gap), then the burst lands all at once, overshoots the
     * limit and the oldest sound is thrown away to get back to the target.
     * Measured on a remote desktop 2026-10-16: 1 to 6 gaps and about 180 ms
     * discarded per 10 s with every packet arriving, from arrival spikes of
     * 40 to 190 ms against an 80 ms reserve. So each gap raises the reserve
     * by `step` (up to maxTarget), and every `decayAfter` samples without a
     * gap it comes back down by `decayStep`, never below where it started.
     *
     * Delay is what the listener notices, so it is held close to the
     * reserve two ways. The trim limit sits only `headroom` above the
     * reserve (not the fixed ring's 170 ms). And a queue that stays more
     * than `drainOver` over the reserve for `drainAfter` samples is trimmed
     * back to it in one small skip: otherwise the excess from a burst is
     * never played off, because the card takes sound at exactly the rate it
     * arrives. The first cut of this (200 ms reserve, 170 ms headroom, no
     * drain) let the queue sit at 230 to 340 ms, and audio fell behind the
     * picture.
     */
    _adapt(ranDry, played) {
        if (!this._adaptive) return;
        if (ranDry) {
            this._clean = 0;
            this._over = 0;
            this._setTarget(Math.min(this._maxTarget, this._target + this._step));
            return;
        }
        if (this._length > this._target + this._drainOver) {
            this._over += played;
            if (this._over >= this._drainAfter) {
                this._over = 0;
                this._pendingTrim = this._length - this._target;
            }
        } else {
            this._over = 0;
        }
        this._clean += played;
        if (this._clean >= this._decayAfter && this._target > this._baseTarget) {
            this._clean = 0;
            this._setTarget(Math.max(this._baseTarget, this._target - this._decayStep));
        }
    }

    _setTarget(t) {
        this._target = t;
        this._limit = t + this._headroom;
        this.stats.target = t;
    }

    get length() {
        return this._length;
    }

    // Append one block of stereo samples.
    write(left, right) {
        let n = left.length;
        let from = 0;
        if (n > this._capacity) {
            from = n - this._capacity;
            this.stats.dropped += from;
            n = this._capacity;
        }
        const overflow = this._length + n - this._capacity;
        if (overflow > 0) this._discard(overflow);

        let w = (this._read + this._length) % this._capacity;
        for (let i = 0; i < n; i++) {
            this._left[w] = left[from + i];
            this._right[w] = right[from + i];
            if (++w === this._capacity) w = 0;
        }
        this._length += n;
        this.stats.written += n;

        if (this._length > this._limit) {
            if (this._adaptive) {
                // Skipped in the next read, crossfaded, rather than cut here:
                // a cut is a jump between two unrelated samples, a click.
                this._pendingTrim = this._length - this._target;
            } else {
                this._discard(this._length - this._target);
            }
        }
    }

    _discard(n) {
        n = Math.min(n, this._length);
        this._read = (this._read + n) % this._capacity;
        this._length -= n;
        this.stats.dropped += n;
    }

    // Fill one output block. Silence while the reserve is being built.
    read(left, right) {
        if (this._adaptive) return this._readAdaptive(left, right);
        const n = left.length;
        if (!this._playing && this._length >= this._target) this._playing = true;
        if (this._playing && this._length < n) {
            this._playing = false;
            this.stats.underruns++;
            this._adapt(true, 0);
        }
        if (!this._playing) {
            left.fill(0);
            right.fill(0);
            return false;
        }
        let r = this._read;
        for (let i = 0; i < n; i++) {
            left[i] = this._left[r];
            right[i] = this._right[r];
            if (++r === this._capacity) r = 0;
        }
        this._read = r;
        this._length -= n;
        this.stats.played += n;
        this._adapt(false, n);
        return true;
    }

    _at(k) {
        let i = this._read + k;
        if (i >= this._capacity) i -= this._capacity;
        return i;
    }

    /*
     * The adaptive read: no hard edges. Three things a fixed ring does with a
     * jump, done smoothly instead (each a click in continuous music, measured
     * as crackle 2026-10-16):
     *
     * - Delay is held at the reserve by playing a little fast or slow, up to
     *   +/-0.5% (inaudible), in proportion to how far the queue is from the
     *   reserve. This also absorbs the slow drift between the sender's sound
     *   clock and this card's, which a fixed rate can only fix by trimming.
     * - A trim (queue past the limit, or an excess that outlived the rate
     *   control) is a one-block crossfade from the old position to the new.
     * - Running dry fades out what is left instead of stopping mid-wave, and
     *   playback resumes with a fade in.
     */
    _readAdaptive(left, right) {
        const n = left.length;
        const L = this._left, R = this._right;
        if (!this._playing) {
            if (this._length < this._target) {
                left.fill(0);
                right.fill(0);
                return false;
            }
            this._playing = true;
            this._fadeIn = true;
            this._frac = 0;
        }

        if (this._pendingTrim > 0) {
            const t = Math.min(this._pendingTrim, this._length - n - 1);
            this._pendingTrim = 0;
            if (t > 0) {
                for (let i = 0; i < n; i++) {
                    const w = (i + 1) / n;
                    const a = this._at(i), b = this._at(t + i);
                    left[i] = L[a] * (1 - w) + L[b] * w;
                    right[i] = R[a] * (1 - w) + R[b] * w;
                }
                const used = t + n;
                this._read = this._at(used);
                this._length -= used;
                this.stats.dropped += t;
                this.stats.played += n;
                this._frac = 0;
                this._adapt(false, n);
                return true;
            }
        }

        const err = (this._length - this._target) / this._headroom;
        const ratio = Math.min(1.005, Math.max(0.995, 1 + 0.005 * err));
        this.stats.rate = ratio;
        const need = Math.ceil(this._frac + n * ratio) + 1;
        if (this._length < need) {
            // Running dry: fade out what is here, then silence.
            const m = this._length;
            for (let i = 0; i < n; i++) {
                if (i < m) {
                    const g = 1 - i / m;
                    const k = this._at(i);
                    left[i] = L[k] * g;
                    right[i] = R[k] * g;
                } else {
                    left[i] = 0;
                    right[i] = 0;
                }
            }
            this._read = this._at(m);
            this._length = 0;
            this.stats.played += m;
            this._frac = 0;
            this._playing = false;
            this.stats.underruns++;
            this._adapt(true, 0);
            return true;
        }

        for (let i = 0; i < n; i++) {
            const pos = this._frac + i * ratio;
            const k = Math.floor(pos);
            const f = pos - k;
            const a = this._at(k), b = this._at(k + 1);
            left[i] = L[a] + (L[b] - L[a]) * f;
            right[i] = R[a] + (R[b] - R[a]) * f;
        }
        if (this._fadeIn) {
            this._fadeIn = false;
            for (let i = 0; i < n; i++) {
                const g = (i + 1) / n;
                left[i] *= g;
                right[i] *= g;
            }
        }
        const adv = this._frac + n * ratio;
        const used = Math.floor(adv);
        this._frac = adv - used;
        this._read = this._at(used);
        this._length -= used;
        this.stats.played += used;
        this._adapt(false, used);
        return true;
    }
}
