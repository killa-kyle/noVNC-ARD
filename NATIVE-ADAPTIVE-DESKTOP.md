# Optional native adaptive private desktop

This candidate adds a native-only media socket and opt-in HP bridge. It does not
establish KMac or physical-iOS acceptance. Defaults, standard rendering, browser
network policy, and shared physical desktops remain unchanged.

## Native contract

`connect` accepts optional `adaptiveDesktop: {enabled:true, privateSession:true,
width,height,scale:1}` and `nativeMedia:true`. This path returns a Promise and must
be awaited. Missing HEVC decode support, Observe, an SSH-backed `transportTrusted`
connection, invalid geometry, or absent native-media authority rejects it.

Native must preflight connected UDP channels to the same resolved saved host as
the direct TCP connection. No host, URL or port is accepted from JavaScript.
Reviewed ports are local/remote audio 5900, video 5901; an HP server notice with
other ports fails closed. Never fall back by changing firewall, opening a public
relay, resizing physical displays, or switching the selected user/session.

JS emits `mediaOpen {session}`, `mediaWrite {session,sequence,base64}`, and
`mediaClose {session}`. Each decoded frame is channel byte 0/1 plus 1..65507 UDP
payload bytes. Native must reject oversized/invalid-channel frames, stale session
IDs, unexpected peer addresses and unavailable bind ports before sending.

Native calls `mediaOpened(session)`, `mediaReceive(session,base64)`,
`mediaAck(session,sequence)`, and `mediaFailed(session,reason)`. Await each receive
before delivering another. Ack only completed sends, not queued sends. Keep native
queues bounded independently. The JS outgoing queue has one outstanding write,
64 packets/256KiB total; overflow closes it. HP pre-key media is likewise bounded.
`mediaClosed` reports a normal underlying close without echoing a close message.
Lifecycle teardown is idempotent; media never survives its TCP session.

`resizeDesktop(session,width,height)` returns **request admitted**, not display
success. Bounds: integer 480..3840 per axis, maximum 8,294,400 pixels, scale 1.
Only the explicit adaptive private Control session while HP is streaming may
resize. Opening/reoffering retains only the latest requested size, with a 15-second
expiry; returning to streaming or ending a reoffer drains it. Requests are at least 350ms apart and upstream rejects overlapping
reoffers. Native should debounce geometry and never spin or retry blindly. Host acknowledgement/framebuffer dimensions
must establish actual effect. `adaptiveDesktop` events report HP state/reason and
availability; loss of capability is not permission to switch a shared monitor.

## Verification

`npm run test:bridge`, `npm run build:native`, and `npm run check:native` cover
synthetic policy, packet/lifecycle bounds, stale sessions and reproducible bundle.
Before shipment, verify HEVC on the real WKWebView, UDP source identity, auth/key
approval, private-session offer, changing framebuffer dimensions, pointer mapping,
portrait/landscape/fold transitions, restore/disconnect, rejection/failure, Observe,
SSH rejection, and simultaneous-session isolation on KMac/Duo. No installed-app
or host mutation has been performed by preparing this candidate.

Live native RTP and RTCP decryption share a 64-packet/256KiB in-flight cap.
Admission occurs before asynchronous crypto work and accounting is released in
`finally`, including rejection. Overflow fails the media session closed. Browser
transport retains its existing policy.

Resize settlement reports confirmed host dimensions only from the HP sink's first
composited picture callback. Timeout, malformed reoffer, and decoder-error paths
clear pending status with an explicitly unconfirmed result, never the requested
size. This separates completion of a resize attempt from evidence it succeeded.
