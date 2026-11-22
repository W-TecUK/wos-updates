# W-OS gateway

A small service that lets W-OS 2 reach the web, W-Mail and W-Life over its own encrypted channel (WTP, see `wtp.js`).

- `server.js` TCP server. Set `GATEWAY_PRIV` (64 hex chars, X25519 private key) and optionally `PORT`.
- `web.js` fetches pages for the OS (no private/internal addresses, size and time limits) and simplifies them.
- `wmail.js` W-Mail / W-Life account commands through `https://api.wmail.life`.
- Nothing is stored. Sign-in tokens live in memory for one connection only.

Run `npm start` with no key set to print a fresh key pair. `npm test` runs a local end-to-end check.
