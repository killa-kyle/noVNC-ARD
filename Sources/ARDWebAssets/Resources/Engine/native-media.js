// Native-only datagram transport. No browser sockets or arbitrary destinations.
export function nativeMediaBridge({session, post, current, encode, decode}) {
    let socket = null, sequence = 0, outstanding = null, queue = [], bytes = 0;
    const valid = () => { if (!current()) throw new Error('Stale media session'); };
    const frame = data => {
        const value = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        if (value.length < 2 || value.length > 65508 || value[0] > 1) throw new Error('Invalid media datagram');
        return value.slice();
    };
    const drain = () => {
        if (socket?.readyState !== 1 || outstanding || !queue.length) return;
        const data = queue.shift(); outstanding = {sequence: ++sequence, length: data.length};
        post({type: 'mediaWrite', session, sequence, base64: encode(data)});
    };
    function close(notify = true, reason = 'Media closed') {
        if (!socket || socket.readyState === 3) return;
        socket.readyState = 3; queue = []; bytes = 0; outstanding = null;
        if (notify) post({type: 'mediaClose', session});
        socket.onclose?.({code: 1000, reason: String(reason).slice(0, 256)});
    }
    class NativeMediaSocket {
        constructor(url, protocol) {
            valid();
            if (socket || url !== 'native-media' || protocol !== 'ard-media') throw new Error('Invalid native media channel');
            this.readyState = 0; this.protocol = 'ard-media'; this.binaryType = 'arraybuffer';
            socket = this;
            post({type: 'mediaOpen', session});
        }
        send(data) {
            valid();
            if (this.readyState !== 1) throw new Error('Media channel not open');
            const value = frame(data);
            if (queue.length + (outstanding ? 1 : 0) >= 64 || bytes + value.length > 262144) {
                close(true, 'Media queue exceeded'); throw new Error('Media queue exceeded');
            }
            queue.push(value); bytes += value.length; drain();
        }
        close() { close(); }
        get bufferedAmount() { return bytes; }
    }
    return {Socket: NativeMediaSocket,
        opened() { valid(); if (socket?.readyState !== 0) throw new Error('Unexpected media open'); socket.readyState = 1; socket.onopen?.({}); drain(); },
        receive(base64) { valid(); if (socket?.readyState !== 1) throw new Error('Media not open');
            if (typeof base64 !== 'string' || base64.length > 87344) throw new Error('Oversized media frame');
            socket.onmessage?.({data: frame(decode(base64)).buffer}); },
        ack(value) { valid(); if (!outstanding || outstanding.sequence !== value) throw new Error('Invalid media acknowledgment'); bytes -= outstanding.length; outstanding = null; drain(); },
        closed(reason) { valid(); close(false, reason); },
        close: () => close(),
    };
}
