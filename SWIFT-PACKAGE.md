# ARDWebAssets native wrapper

This branch packages a pinned noVNC-ARD rendering engine for a native WKWebView.
It preserves the MPL source and notices; no iShareScreen/AGPL code is included.
Upstream noVNC-ARD: d699293635083c9e0c30c8f9480993865653772a.
Upstream noVNC core: 8e1ebdffba02e651c399dacef841f8941f6ad6e4.
The resource tree materializes core and vendor/pako, rather than relying on a
consumer's submodule checkout. Optional HP audio/WASM/relay assets are excluded.
The packaged ARD patch changes its optional audio factory to null and preserves
explicit mode 0 instead of defaulting it to Control mode. High
Performance is hard-disabled; MVS adaptive framebuffer quality remains available.

Import `ARDWebAssets`; load `ARDWebAssets.indexURL`, with read access restricted
to `ARDWebAssets.bundleURL` (the Engine directory). Assets are all local. WebKit
classic-script loading and WebCrypto availability still require actual platform validation;
the offline resource tests do not establish either. Do not enable unsupported
file access preferences or fetch scripts over the network.

Register WKScriptMessageHandler name `kyleARD` before loading. Native code owns
the fixed TCP endpoint and must reject messages from other frames/origins. JS
never chooses a host. Deny external navigation, new windows and downloads, use a
nonpersistent data store, and remove the handler/disconnect on teardown. The
index CSP forbids external connections, workers and embedded objects.

## JavaScript API

`window.KyleARD` is installed before ready. Call with structured
callAsyncJavaScript arguments, not interpolated script text. Every method after
connect takes the same session string first; stale sessions throw.

- `connect({session, identity, username?, password?, viewOnly?, quality?, transportTrusted?})`:
  session is a native UUID; identity is a canonical native host:port key. Native
  connects only its saved endpoint. `transportTrusted` means an independently
  verified SSH tunnel, not a user preference or JS-supplied hostname.
- `opened(session)`: native TCP ready. Incoming greetings are buffered until open.
- `receive(session, base64)`: up to 65,536 decoded bytes per call, ordered. Native
  should await each JavaScript completion before reading/delivering another chunk.
- `ack(session, sequence)`: acknowledge a write only after native NW send completes.
- `transportClosed(session, reason)` and `disconnect(session)`.
- `credentials(session, username, password)`: session-memory credentials only.
- `trust(session, accept)`: answer pending exact RSA key approval. Native must
  compute/check/persist the fingerprint before accepting, including changed keys.
- `key(session, keysym, down)`, `type(session, text)` (Unicode keysyms),
  `pointer(session, framebufferX, framebufferY)` (move without held buttons).
- `clipboard(session, operation, text?)`: `send`, `get`, `revoke`. Revoke clears
  remembered outgoing content and received generic text even in Observe mode.
  Generic RFB get returns the last received server text (cached:true); RFB cannot
  request a fresh ordinary ServerCutText. With no cached value it emits
  clipboardUnavailable. No browser clipboard access.
- `curtain(session, active, message?)`: upstream's curtain event is a local
  requested state, not proof the server has hidden its physical display.
- `selectSession(session, 1|2)`: share/private, only as offered in a session event.
  No silent session selection is performed. A post-init quality-choice pause
  without server SessionSelect offers share only.
- `selectDisplay(session, id|null)`, `observe(session, bool)`,
  `quality(session, 'adaptive'|'millions'|'thousands'|'gray'|'halftone')`.

## Messages to native

Top-level `type` is one of:

- `ready`: detail has `bridgeVersion:1`, upstream revision, secureContext/webCrypto.
- `open`: session. Connect the native-chosen endpoint and call opened on success.
- `write`: session, monotonically increasing sequence, base64. One outstanding
  write at a time, 64 KiB chunks, total queued data limited to 8 MiB. Acknowledge
  with ack; on failure close transport instead of acknowledging success.
- `close`: session. Native closes that exact connection.
- `event`: session, event, detail. Events are connected; disconnected/error with
  reason; credentials with types; clipboard with text; resize with width/height;
  hostkey with identity/kind/derBase64; session with canShare/canPrivate/username;
  capabilities with apple/curtain/adaptive/textClipboard/richClipboard; displays
  with upstream width/height/displays; encryption with state; curtain with
  active and acknowledged:false.

No RSA key is silently trusted or stored in WebKit localStorage. The adapter
pauses RSA credential encryption until native approval. Type 30 DH lacks a
stable authenticated server identity and therefore fails unless native already
provides a verified SSH transport. Avoid relabeling encryption as authentication.
Apple rich archives have a bounded native bridge; remote application support
still requires host validation. Standard RFB remains text-only and uses its
ordinary clipboardPasteFrom path, whose legacy ClientCutText is Latin-1 unless
extended-clipboard support is negotiated. Entering Observe clears both received
and outgoing clipboard caches, preventing delayed extended-clipboard requests
from serving remembered outgoing text. Server-rendered content and
metadata remain untrusted. This wrapper has no production-host validation yet.

`swift test` checks resource lookup, the full bootstrap static import graph,
asset exclusions, and bridge entry points on macOS. It does not execute a remote
session. Source tests and all original notices remain available in this branch.

## Reproducible classic bundle

The index loads `bootstrap.bundle.js` as an ordinary script because file-origin
ES-module loading failed in the observed Duo WebKit environment despite readable
resources and available WebCrypto. This is a candidate remedy, not proof until
the same native environment is rerun. Original MPL source resources remain
packaged; inline legal headers and the pako MIT notice are preserved in the
bundle. No HTTP server, external script loading or security preference override
is introduced.

Use `npm ci --ignore-scripts` then `npm run build:native` with esbuild pinned to
0.25.12 in package-lock.json. `npm run check:native` reproduces the bytes and
verifies the checked-in SHA256. The build has no timestamp or source-map path
input. Upstream top-level await runs inside an async IIFE, preserving capability
detection order without requiring any browser ES-module loading. A startupError
message reports exceptions before the normal ready event. Swift package tests verify the classic index, resource presence and
compiled bundle hash; they do not execute its browser code.

## Bounded rich Apple pasteboard API

The Apple receive handler checks compressed and expanded lengths against 8 MiB
**before** waiting for the payload or allocating inflation output. The inflater
allocates at most declared size plus one sentinel byte; it rejects extra expansion,
trailing compressed data, invalid framing, missing flush/end and archive parsing
failures. Parsed archives allow at most 64 flavors, 16 aliases per flavor, 1024
UTF-8 bytes per nonempty type name, 4 MiB per flavor/alias value, and 8 MiB total.
Unknown UTIs remain opaque; native code must whitelist its supported OS types.

On receipt, event `clipboardArchive` has `{transfer, length}`. It replaces the
previous received archive; no entire image is posted through WKScriptMessageHandler.

- `clipboardArchiveRead(session, transfer, offset, length)` returns base64 for a
  maximum of 65,536 bytes. Native pulls sequentially and bounds its own assembly.
- `clipboardArchiveRelease(session, transfer)` clears the received bytes.
- `clipboardArchiveBegin(session, transfer, total)` allocates an upload capped at
  8 MiB and immediately revokes previously approved outgoing rich/text data.
- `clipboardArchiveChunk(session, transfer, offset, base64)` accepts at most 64 KiB
  decoded bytes and requires an exact next offset. A malformed chunk aborts upload.
- `clipboardArchiveCommit(session, transfer)` requires all declared bytes, validates
  the archive before compression, queues the Apple 0x1f message and returns true.
  True means queued, not confirmation that the Mac applied its pasteboard.

These APIs require an Apple session connected in Control mode. Ordinary RFB
continues to use text-only clipboard APIs. Observe/revoke/transport close clears
received, pending-upload and approved-outgoing archives and text caches. Delayed
server data-needed messages may only use the current approved cache in Control
mode. A newer text send supersedes a previously approved rich archive. Each
archive is bounded; a session can hold one incoming, one pending upload and one
approved outgoing archive, each at most 8 MiB. No browser clipboard API is used.

Ten Node tests cover codec compression/opaque rich flavors, synthetic wire
headers, malformed/truncated records, expansion-bound rejection, pull/upload
chunks, release/revoke/Observe/close, standard RFB fallback and performance
counters. They execute the original codec/adapter with a protocol-engine test
double; they are not real-Mac interoperability evidence.

## Performance observations

`performance(session)` returns bounded metadata only: elapsedMs, receivedBytes,
framebufferUpdates, rectangleCalls, rectanglesCompleted, decodeMilliseconds,
encodings (up to 64 IDs, each rectangles/milliseconds), width, height, renderPending,
canvasDrawFlips, canvasFlipMilliseconds, flushCompletions and flushWaitMilliseconds.
The adapter also emits `performance` at most once per second while connected.
Counters are cumulative within a session. No host, user, credentials, clipboard
or image contents are included. Successful framebuffer-update calls count server
updates, including metadata/empty updates; they are not presented-frame FPS.
Decoder timing includes synchronous partial work; completed rectangles count
only successful calls. Canvas metrics count draw-bearing flips and their
synchronous time; flush metrics count completed flush waits, not frame displays.
