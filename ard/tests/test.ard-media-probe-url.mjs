/*
 * noVNC-ARD: media probe URL construction
 *
 * The probe in ard.html appends `probe` to the media URL. It must do so as a
 * query param so it works for BOTH endpoint shapes:
 *   - M1 server, path-based:  ws://h/ws/vnc-media/<id>         -> ?probe
 *   - M2 webrtc-ra, query-based: ws://h/ws/vnc-media?token=…&sessionId=… -> &probe
 * A blind '?probe' on the M2 URL glued '?probe' onto the sessionId value, so the
 * agent looked up a sessionId that did not exist (503) and HP greyed out.
 *
 * Run: node --test ard/tests/test.ard-media-probe-url.mjs
 */

import { describe, it } from 'node:test';
import { strictEqual } from 'node:assert';

// Mirrors the separator logic in ard.html ardProbeMedia().
function probeUrl(url) {
    const sep = url.includes('?') ? '&' : '?';
    return url + sep + 'probe';
}

describe('media probe URL', () => {
    it('uses ? for a query-less (M1 path-based) media URL', () => {
        strictEqual(
            probeUrl('ws://h:9000/ws/vnc-media/abc-123'),
            'ws://h:9000/ws/vnc-media/abc-123?probe',
        );
    });

    it('uses & for a query-bearing (M2 webrtc-ra) media URL', () => {
        strictEqual(
            probeUrl('ws://localhost:19230/ws/vnc-media?token=t&sessionId=57ee068e'),
            'ws://localhost:19230/ws/vnc-media?token=t&sessionId=57ee068e&probe',
        );
    });

    it('keeps the sessionId value intact on a query-bearing URL', () => {
        const url = probeUrl('ws://h/ws/vnc-media?token=t&sessionId=57ee068e-3a94-4bcb-90db-f9cd22167dbf');
        const sid = new URL(url.replace(/^ws/, 'http')).searchParams.get('sessionId');
        strictEqual(sid, '57ee068e-3a94-4bcb-90db-f9cd22167dbf');
    });
});
