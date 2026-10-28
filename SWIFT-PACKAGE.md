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
Clipboard currently supports text, not rich flavors. Standard RFB uses its
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

## Performance-only branch

This branch starts from the deployed classic-script revision 462ca31 and adds
instrumentation only. It deliberately retains that revision's text clipboard,
password-handling, transport chunking, rendering and quality behavior. Rich
archive implementation remains separately on swift-package-assets at fd541b4.

`performance(session)` returns cumulative bounded metadata: elapsedMs,
receivedBytes, framebufferUpdates, rectangleCalls, rectanglesCompleted,
decodeMilliseconds, encodings (at most 64 IDs, each rectangles/milliseconds),
width, height, renderPending, canvasDrawFlips, canvasFlipMilliseconds,
flushCompletions, flushWaitMilliseconds. The adapter also emits a performance
event every 1,000 ms only while connected and cancels its timer on closure.
No host, username, credentials, image or clipboard contents are included.

Successful framebuffer-update calls count protocol updates, including metadata
or empty updates, not presented-frame FPS. Decoder timing accumulates synchronous
partial work; completed rectangles increment only when the decoder returns true.
Draw-bearing canvas flips and their synchronous elapsed time are measured
separately from completed flush waits. Metrics identify where time is spent;
they do not establish a faster quality preset or diagnose a bottleneck alone.

Rich Apple pasteboard archive support is merged with the native transport flush, pointer-mask, and performance instrumentation paths. The explicit chunked archive API retains the bounded codec and Observe/revoke gates; native integration and actual Mac transfer require separate acceptance.
