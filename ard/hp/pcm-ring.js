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
     * adaptive: grow the reserve when it runs dry, shrink it back slowly
     *           (see _adapt); off by default, so a caller that does not ask
     *           keeps exactly the fixed reserve above
     * maxTarget, step, decayStep, decayAfter: the adaptive reserve's bounds,
     *           in samples per channel
     */
    constructor({
        capacity = 24000, target = 3840, limit = 12000,
        adaptive = false, maxTarget = 9600, step = 1920, decayStep = 480, decayAfter = 480000,
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
        this._headroom = limit - target;
        this._maxTarget = Math.max(target, maxTarget);
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
     * by `step` (up to maxTarget), the limit keeps its headroom above it, and
     * every `decayAfter` samples without a gap it comes back down by
     * `decayStep`, never below where it started. The added delay lasts only
     * as long as the arrivals stay uneven.
     */
    _adapt(ranDry, played) {
        if (!this._adaptive) return;
        if (ranDry) {
            this._clean = 0;
            this._setTarget(Math.min(this._maxTarget, this._target + this._step));
            return;
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
            this._discard(this._length - this._target);
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
}
