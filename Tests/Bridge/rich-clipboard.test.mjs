import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as constants from '../../Sources/ARDWebAssets/Resources/Engine/ard/ard-constants.js';
import { randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { fixture } from './fixture.mjs';
import { ARCHIVE_LIMIT, CHUNK_LIMIT, encodeArchive, validateArchive, clipboardHeader, compressArchive, decompressArchive } from '../../Sources/ARDWebAssets/Resources/Engine/clipboard-codec.js';

function archive() {
    return encodeArchive([
        {type: 'public.utf8-plain-text', data: new TextEncoder().encode('Hello 世界'), aliases: [{name: 'public.mime-type', value: new TextEncoder().encode('text/plain;charset=utf-8')}]},
        {type: 'public.png', data: new Uint8Array(randomBytes(190000))},
        {type: 'public.rtf', data: new TextEncoder().encode('{\\rtf1 rich}'), reserved: 3},
        {type: 'public.url', data: new TextEncoder().encode('https://example.com')},
    ]);
}
function message(bytes) {
    const compressed = compressArchive(bytes);
    const result = new Uint8Array(16 + compressed.length); const view = new DataView(result.buffer);
    result[0] = 0x1f; view.setUint32(4, 19); view.setUint32(8, bytes.length); view.setUint32(12, compressed.length);
    result.set(compressed, 16); return result;
}
function socket(bytes) {
    let offset = 0;
    return {waits: [],
        rQwait(label, length) { this.waits.push({label, length}); return length > bytes.length - offset; },
        rQpeekBytes(length) { return bytes.slice(offset, offset + length); },
        rQskipBytes(length) { offset += length; },
        rQshift16() { const result = bytes[offset] * 256 + bytes[offset + 1]; offset += 2; return result; },
        rQshiftBytes(length) { const result = bytes.slice(offset, offset + length); offset += length; return result; },
    };
}
function appleFixture() {
    const result = fixture(); result.rfb._rfbAppleARD = true; return result;
}
function upload(api, bytes, transfer = 'upload') {
    api.clipboardArchiveBegin('test-session', transfer, bytes.length);
    for (let offset = 0; offset < bytes.length; offset += CHUNK_LIMIT)
        api.clipboardArchiveChunk('test-session', transfer, offset, Buffer.from(bytes.subarray(offset, offset + CHUNK_LIMIT)).toString('base64'));
    return api.clipboardArchiveCommit('test-session', transfer);
}

test('bounded codec preserves rich flavors through zlib flush and finished streams', () => {
    const data = archive();
    const decoded = validateArchive(data);
    assert.equal(decoded.length, 4); assert.equal(decoded[1].data.length, 190000);
    assert.deepEqual(decompressArchive(compressArchive(data), data.length), data);
    assert.deepEqual(decompressArchive(new Uint8Array(deflateSync(data)), data.length), data);
    assert.deepEqual(decompressArchive(compressArchive(new Uint8Array()), 0), new Uint8Array());
    for (const length of [1, 3, 4, 10, data.length - 1]) assert.throws(() => validateArchive(data.subarray(0, length)));
    assert.throws(() => validateArchive(new Uint8Array([...data, 0])));
    assert.throws(() => validateArchive(new Uint8Array([255, 255, 255, 255])));
    assert.throws(() => validateArchive(new Uint8Array([0, 0, 0, 1, 255, 255, 255, 255])));
    assert.throws(() => encodeArchive([{type: 'bad\0type', data: new Uint8Array()}]));
    assert.throws(() => encodeArchive([{type: 'public.data', data: new Uint8Array(4 * 1024 * 1024 + 1)}]));
});

test('inflater rejects declared-size bombs, malformed streams, oversized headers and trailing bytes', () => {
    const data = archive(); const compressed = compressArchive(data);
    assert.throws(() => decompressArchive(compressed, 4));
    assert.throws(() => decompressArchive(compressed, data.length + 1));
    assert.throws(() => decompressArchive(compressed, ARCHIVE_LIMIT + 1));
    assert.throws(() => decompressArchive(compressed.slice(0, -1), data.length));
    assert.throws(() => decompressArchive(new Uint8Array([...compressed, 0]), data.length));
    assert.throws(() => decompressArchive(new Uint8Array([1, 2, 3]), 0));
    const header = message(new Uint8Array()).slice(0, 16);
    new DataView(header.buffer).setUint32(8, ARCHIVE_LIMIT + 1);
    assert.throws(() => clipboardHeader(header));
    const {rfb} = appleFixture(); rfb._sock = socket(header.slice(1));
    assert.equal(rfb._ardHandleServerClipboard(), false);
    assert.match(rfb.failure, /Invalid Apple pasteboard/);
    assert.equal(rfb._sock.waits.length, 1, 'oversized declaration rejected before payload wait/inflation');
});

test('receive exposes a bounded pull transfer and release revokes further access', () => {
    const {api, rfb, messages} = appleFixture(); const data = archive();
    rfb._sock = socket(message(data).slice(1));
    assert.equal(rfb._ardHandleServerClipboard(), true);
    const metadata = messages.findLast(value => value.event === 'clipboardArchive').detail;
    assert.equal(metadata.length, data.length);
    const chunks = [];
    for (let offset = 0; offset < metadata.length; offset += CHUNK_LIMIT)
        chunks.push(Buffer.from(api.clipboardArchiveRead('test-session', metadata.transfer, offset, Math.min(CHUNK_LIMIT, metadata.length - offset)), 'base64'));
    assert.deepEqual(Buffer.concat(chunks), Buffer.from(data));
    assert.throws(() => api.clipboardArchiveRead('test-session', metadata.transfer, 0, CHUNK_LIMIT + 1));
    assert.throws(() => api.clipboardArchiveRead('test-session', metadata.transfer, -1, 1));
    api.clipboardArchiveRelease('test-session', metadata.transfer);
    assert.throws(() => api.clipboardArchiveRead('test-session', metadata.transfer, 0, 1));
});

test('outbound chunks commit exact archive and malformed/order failures never become delayed data', () => {
    const {api, rfb} = appleFixture(); const data = archive(); rfb._sock = {};
    assert.equal(upload(api, data), true);
    const sent = rfb._sock.sentArchive;
    assert.deepEqual(decompressArchive(sent.bytes, sent.expanded), data);
    assert.deepEqual(rfb._kyleClipboardArchiveOutgoing, data);
    api.clipboardArchiveBegin('test-session', 'bad', 4);
    assert.equal(rfb._kyleClipboardArchiveOutgoing, null, 'begin revokes prior approved archive');
    assert.throws(() => api.clipboardArchiveChunk('test-session', 'bad', 1, 'AAAAAA=='));
    assert.throws(() => api.clipboardArchiveCommit('test-session', 'bad'));
    api.clipboardArchiveBegin('test-session', 'malformed', 4);
    api.clipboardArchiveChunk('test-session', 'malformed', 0, '/////w==');
    assert.throws(() => api.clipboardArchiveCommit('test-session', 'malformed'));
    assert.equal(rfb._kyleClipboardArchiveOutgoing, null);
    assert.throws(() => api.clipboardArchiveBegin('test-session', 'big', ARCHIVE_LIMIT + 1));
});

test('Observe, revoke and transport close clear both directions and delayed promise caches', () => {
    for (const action of ['observe', 'revoke', 'close']) {
        const {api, rfb, messages} = appleFixture(); const data = archive();
        rfb._sock = socket(message(data).slice(1)); rfb._ardHandleServerClipboard();
        const metadata = messages.findLast(value => value.event === 'clipboardArchive').detail;
        upload(api, data); api.clipboardArchiveBegin('test-session', 'pending', 4);
        if (action === 'observe') api.observe('test-session', true);
        if (action === 'revoke') api.clipboard('test-session', 'revoke');
        if (action === 'close') api.transportClosed('test-session', 'fixture ended');
        assert.equal(rfb._kyleClipboardArchiveOutgoing, null);
        assert.equal(rfb._ardClipboardOutgoing, null);
        assert.equal(rfb._clipboardText, null);
        assert.throws(() => api.clipboardArchiveRead('test-session', metadata.transfer, 0, 1));
        assert.throws(() => api.clipboardArchiveCommit('test-session', 'pending'));
        if (action === 'observe') {
            rfb._sock = socket(message(data).slice(1)); rfb._ardHandleServerClipboard();
            api.observe('test-session', false);
            assert.throws(() => api.clipboardArchiveRead('test-session', metadata.transfer, 0, 1));
        }
    }
});

test('performance metrics count completed framebuffer updates, not transport chunks', () => {
    const {api, rfb} = fixture();
    api.receive('test-session', 'AQID'); api.receive('test-session', 'BA==');
    assert.equal(api.performance('test-session').receivedBytes, 4);
    assert.equal(api.performance('test-session').framebufferUpdates, 0);
    rfb._handleRect(); rfb._framebufferUpdate();
    const metrics = api.performance('test-session');
    assert.equal(metrics.framebufferUpdates, 1); assert.equal(metrics.rectanglesCompleted, 1);
    assert.equal(metrics.encodings['1011'].rectangles, 1);
    assert.ok(metrics.decodeMilliseconds >= 0);
    assert.equal(metrics.width, 100); assert.equal(metrics.height, 50);
});

test('actual packaged data-needed handler only replays current approved bytes in Control mode', () => {
    const {api, rfb, context} = appleFixture(); const data = archive();
    Object.assign(context, constants, {Log: {Info() {}, Debug() {}, Warn() {}}});
    const source = readFileSync(new URL('../../Sources/ARDWebAssets/Resources/Engine/ard/ard-patch.js', import.meta.url), 'utf8');
    const begin = source.indexOf('RFB.prototype._ardHandleStateChange = function');
    const end = source.indexOf('// ServerClipboard:', begin);
    vm.runInContext(source.slice(begin, end), context);
    rfb._sock = {}; upload(api, data);
    const needed = () => {
        rfb._sock = socket(new Uint8Array([0, 0, 4, 0, 1, 0, 3]));
        assert.equal(rfb._ardHandleStateChange(), true);
        return rfb._sock.sentArchive;
    };
    assert.deepEqual(decompressArchive(needed().bytes, data.length), data);
    api.clipboard('test-session', 'revoke'); assert.equal(needed(), undefined);
    rfb._sock = {}; upload(api, data);
    api.observe('test-session', true); assert.equal(needed(), undefined);
    api.observe('test-session', false); assert.equal(needed(), undefined);
});
