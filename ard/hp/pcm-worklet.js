/*
 * High Performance mode — AudioWorklet processor that plays what the
 * decoder produces. Runs on the audio thread; the page posts it blocks of
 * stereo samples ({ left, right } as Float32Array).
 */

import { PcmRing } from './pcm-ring.js';

class ArdPcmProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        // processorOptions.ring: PcmRing options from AudioSink.create().
        this._ring = new PcmRing((options && options.processorOptions && options.processorOptions.ring) || {});
        this._blocks = 0;
        this.port.onmessage = (e) => {
            const m = e.data;
            if (m && m.left && m.right) this._ring.write(m.left, m.right);
        };
    }

    process(inputs, outputs) {
        const out = outputs[0];
        if (!out || out.length === 0) return true;
        const left = out[0];
        const right = out.length > 1 ? out[1] : new Float32Array(left.length);
        this._ring.read(left, right);

        // About once a second: tell the page how the buffer is doing.
        if (++this._blocks % 375 === 0) {
            this.port.postMessage(Object.assign({ queued: this._ring.length }, this._ring.stats));
        }
        return true;
    }
}

registerProcessor('ard-pcm', ArdPcmProcessor);
