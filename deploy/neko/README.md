# Witt collaborative browser

The Neko browser runs separately from Witt chat. The previous Chrome/x11vnc service and its profile are preserved as the compatibility mode.

- Neko image: `ghcr.io/m1k1o/neko/chromium@sha256:270face8b8111e639744fb7bcdbbf0deed227900bb89d58b2f8adfc12af8c41e`.
- Neko config/profile: `/var/lib/witt/neko/config`, `/var/lib/witt/neko/profile`.
- Neko HTTP: loopback port 8095. Chromium CDP: loopback port 9223.
- Gateway: loopback port 3004. It reuses Witt authentication without writing authentication records.
- Public access: `/vault-api/browser/room/`, checked by the gateway for every HTTP request and WebSocket connection. Witt cookies/bearer credentials are never forwarded to Neko. Nginx access logging is disabled on room and websocket routes to avoid recording session-bearing URLs.
- Every login creates an independent Neko member/session. The native room UI exposes members and control handoff.
- Desktop dock leaves chat accessible; narrow screens can return to chat without destroying the iframe/session.

## Rollout

WebRTC uses UDP/TCP 52100. On 2026-11-26 the user explicitly approved opening those ports. The `witt-neko-media` ingress rule now allows only UDP/TCP 52100, targets the dedicated `witt-neko-media` tag, and that tag is present only on instance `witt-server` in `asia-northeast1-b` (project `witt-515905`). Before any firewall modification, obtain explicit user approval for the exact target and scope. Apply a dedicated tag to this instance and target only that tag; do not widen an existing shared rule.

The marker `/var/lib/witt/neko/public-ready` is now present and Neko is the default entry. Before any future rollout without approval and public connectivity validation, this marker must remain absent. The browser entry automatically returns the existing compatibility viewer while retaining the dock layout. After the approved firewall change and validation, create the empty marker file. The next page refresh/reconnect in collaboration mode will use Neko; no chat restart is needed. Removing only this marker rolls back the default entry without changing any browser profile.

The original Chrome profile is retained in place; it has not been copied into the new Chromium profile while the old browser is running.

## Checks

Run `node --test tests/neko-proxy-check.cjs` for authorization, credential stripping, cross-origin rejection and independent WebSocket connections.

The live browser smoke test also verified two separate browser contexts receiving 1280x800 WebRTC video simultaneously, desktop dock geometry, phone chat input and persistent frame state when switching back to chat. An additional test without private-address rewriting verified both live WebRTC peers selected UDP `136.110.95.193:52100` and received media bytes concurrently. This public-address loopback test does not measure the latency or reachability of every end-user network.

Service health: `systemctl is-active witt-neko witt-browser-gateway witt nginx`; `curl http://127.0.0.1:3004/health`. Anonymous public room requests must return 401.
