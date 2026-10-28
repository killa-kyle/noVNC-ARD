// Original bounded Apple pasteboard framing. Protocol sources are cited in
// SWIFT-PACKAGE.md; no implementation from iShareScreen is incorporated.
import { inflateInit, inflate, inflateEnd } from './noVNC/vendor/pako/lib/zlib/inflate.js';
import ZStream from './noVNC/vendor/pako/lib/zlib/zstream.js';
import Deflator from './noVNC/core/deflator.js';

export const ARCHIVE_LIMIT = 8 * 1024 * 1024;
export const CHUNK_LIMIT = 65536;
const FLAVOR_LIMIT = 4 * 1024 * 1024;
const ITEM_LIMIT = 64;
const ALIAS_LIMIT = 16;
const NAME_LIMIT = 1024;
const decoder = new TextDecoder('utf-8', {fatal: true});
const encoder = new TextEncoder();
function bounded(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length > ARCHIVE_LIMIT)
        throw new Error('Invalid or oversized pasteboard archive');
}
export function validateArchive(bytes) {
    bounded(bytes);
    if (!bytes.length) return [];
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 0;
    const u32 = () => {
        if (bytes.length - offset < 4) throw new Error('Truncated pasteboard integer');
        const value = view.getUint32(offset); offset += 4; return value;
    };
    const field = maximum => {
        const length = u32();
        if (length > maximum || length > bytes.length - offset)
            throw new Error('Oversized or truncated pasteboard field');
        const value = bytes.subarray(offset, offset + length); offset += length; return value;
    };
    const name = () => {
        const value = field(NAME_LIMIT);
        if (!value.length || value.includes(0)) throw new Error('Invalid pasteboard type name');
        return decoder.decode(value);
    };
    const count = u32();
    if (count > ITEM_LIMIT) throw new Error('Too many pasteboard items');
    const items = [];
    for (let item = 0; item < count; item++) {
        const type = name(); const reserved = u32(); const count = u32();
        if (count > ALIAS_LIMIT) throw new Error('Too many pasteboard aliases');
        const aliases = [];
        for (let alias = 0; alias < count; alias++) aliases.push({name: name(), value: field(FLAVOR_LIMIT)});
        items.push({type, reserved, aliases, data: field(FLAVOR_LIMIT)});
    }
    if (offset !== bytes.length) throw new Error('Trailing pasteboard bytes');
    return items;
}
export function encodeArchive(items) {
    if (!Array.isArray(items) || items.length > ITEM_LIMIT) throw new Error('Too many pasteboard items');
    const parts = []; let total = 0;
    const append = bytes => {
        if (total + bytes.length > ARCHIVE_LIMIT) throw new Error('Oversized pasteboard archive');
        parts.push(bytes); total += bytes.length;
    };
    const u32 = value => {
        if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new Error('Invalid pasteboard integer');
        const data = new Uint8Array(4); new DataView(data.buffer).setUint32(0, value); append(data);
    };
    const field = (bytes, maximum) => {
        if (!(bytes instanceof Uint8Array) || bytes.length > maximum) throw new Error('Oversized pasteboard field');
        u32(bytes.length); append(bytes);
    };
    const name = value => {
        if (typeof value !== 'string' || !value.length || value.includes('\0')) throw new Error('Invalid pasteboard type name');
        field(encoder.encode(value), NAME_LIMIT);
    };
    u32(items.length);
    for (const item of items) {
        name(item.type); u32(item.reserved ?? 0);
        const aliases = item.aliases || [];
        if (!Array.isArray(aliases) || aliases.length > ALIAS_LIMIT) throw new Error('Too many pasteboard aliases');
        u32(aliases.length);
        for (const alias of aliases) { name(alias.name); field(alias.value, FLAVOR_LIMIT); }
        field(item.data, FLAVOR_LIMIT);
    }
    const result = new Uint8Array(total); let offset = 0;
    for (const part of parts) { result.set(part, offset); offset += part.length; }
    return result;
}
export function clipboardHeader(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length !== 16 || bytes[0] !== 0x1f)
        throw new Error('Invalid pasteboard message header');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const session = view.getUint32(4); const expanded = view.getUint32(8); const compressed = view.getUint32(12);
    if (expanded > ARCHIVE_LIMIT || compressed > ARCHIVE_LIMIT || (!compressed && expanded))
        throw new Error('Oversized or inconsistent pasteboard message');
    return {session, expanded, compressed};
}
export function decompressArchive(compressed, expected) {
    bounded(compressed);
    if (!Number.isInteger(expected) || expected < 0 || expected > ARCHIVE_LIMIT)
        throw new Error('Oversized expanded pasteboard archive');
    if (!compressed.length) {
        if (expected) throw new Error('Missing compressed pasteboard');
        return new Uint8Array();
    }
    const stream = new ZStream();
    if (inflateInit(stream) !== 0) throw new Error('Cannot initialize pasteboard inflater');
    try {
        // One sentinel byte detects output exceeding the declared size. No
        // attacker-controlled expansion can allocate beyond ARCHIVE_LIMIT + 1.
        const output = new Uint8Array(expected + 1);
        stream.input = compressed; stream.next_in = 0; stream.avail_in = compressed.length;
        stream.output = output; stream.next_out = 0; stream.avail_out = output.length;
        const status = inflate(stream, 0);
        const flushed = compressed.length >= 4 && compressed.at(-4) === 0 && compressed.at(-3) === 0 &&
            compressed.at(-2) === 255 && compressed.at(-1) === 255;
        if (status < 0 || stream.next_out !== expected || stream.avail_in !== 0 || (status !== 1 && !flushed))
            throw new Error('Invalid or mismatched compressed pasteboard');
        const result = output.slice(0, expected);
        validateArchive(result); return result;
    } finally { inflateEnd(stream); }
}
export function compressArchive(bytes) {
    validateArchive(bytes);
    const result = new Deflator().deflate(bytes);
    if (result.length > ARCHIVE_LIMIT) throw new Error('Compressed pasteboard exceeds limit');
    return result.slice();
}
