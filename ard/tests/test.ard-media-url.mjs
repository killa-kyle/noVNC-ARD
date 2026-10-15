/*
 * noVNC-ARD: ardHpMediaUrl() tests for msgport media URL support
 *
 * Run: node --test ard/tests/test.ard-media-url.mjs
 */

import { describe, it } from 'node:test';
import { strictEqual } from 'node:assert';

// Minimal standalone implementation of ardHpMediaUrl() for testing
function ardHpMediaUrlStandalone(opts) {
    const { path, mediaUrl, mediaPath, host, port, encrypt } = opts;

    if (path === 'msgport') {
        return mediaUrl || null;
    }
    const resolvedHost = host || 'localhost';
    const scheme = encrypt ? 'wss' : 'ws';
    const portStr = port ? ':' + port : '';
    return scheme + '://' + resolvedHost + portStr + '/' + mediaPath;
}

describe('ardHpMediaUrl', () => {
    it('returns supplied media URL when path is msgport and mediaUrl is present', () => {
        const result = ardHpMediaUrlStandalone({
            path: 'msgport',
            mediaUrl: 'ws://localhost:9000/ws/vnc-media?token=abc123&sessionId=xyz',
            mediaPath: 'media',
            host: 'example.com',
            port: 5900,
            encrypt: false,
        });
        strictEqual(result, 'ws://localhost:9000/ws/vnc-media?token=abc123&sessionId=xyz');
    });

    it('returns null when path is msgport and mediaUrl is not present', () => {
        const result = ardHpMediaUrlStandalone({
            path: 'msgport',
            mediaUrl: null,
            mediaPath: 'media',
            host: 'example.com',
            port: 5900,
            encrypt: false,
        });
        strictEqual(result, null);
    });

    it('ignores mediaUrl and builds URL for non-msgport paths', () => {
        const result = ardHpMediaUrlStandalone({
            path: 'ard',
            mediaUrl: 'ws://localhost:9000/ws/vnc-media',
            mediaPath: 'media',
            host: 'example.com',
            port: 5900,
            encrypt: false,
        });
        strictEqual(result, 'ws://example.com:5900/media');
    });

    it('builds NATS URL without port when port is not specified', () => {
        const result = ardHpMediaUrlStandalone({
            path: 'ard',
            mediaUrl: null,
            mediaPath: 'media',
            host: 'example.com',
            port: null,
            encrypt: false,
        });
        strictEqual(result, 'ws://example.com/media');
    });

    it('uses wss scheme when encrypt is true for non-msgport paths', () => {
        const result = ardHpMediaUrlStandalone({
            path: 'ard',
            mediaUrl: null,
            mediaPath: 'media',
            host: 'example.com',
            port: 5900,
            encrypt: true,
        });
        strictEqual(result, 'wss://example.com:5900/media');
    });

    it('uses custom media path for non-msgport', () => {
        const result = ardHpMediaUrlStandalone({
            path: 'ard',
            mediaUrl: null,
            mediaPath: 'custom-media-path',
            host: 'example.com',
            port: null,
            encrypt: false,
        });
        strictEqual(result, 'ws://example.com/custom-media-path');
    });
});
