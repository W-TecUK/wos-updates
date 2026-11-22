'use strict';
// W-OS gateway. Accepts WTP connections from W-OS 2 and does web / W-Mail / W-Life requests for it.
// Safety: key pinned in the OS, per-IP and per-connection rate limits, no private/internal addresses,
// credentials and tokens only live in memory for the life of one connection, nothing is written to disk.
const net = require('node:net');
const dns = require('node:dns').promises;
const wtp = require('./wtp');
const web = require('./web');
const wmail = require('./wmail');

const PORT = parseInt(process.env.PORT || '9000', 10);
const privHex = process.env.GATEWAY_PRIV;
if (!privHex || privHex.length !== 64) {
  const kp = wtp.newKeypair();
  console.log('No GATEWAY_PRIV set. Example key pair (set GATEWAY_PRIV to the private hex, put the public hex in the OS):');
  console.log('PRIV=' + kp.priv.toString('hex'));
  console.log('PUB =' + kp.pub.toString('hex'));
  process.exit(1);
}
const STATIC_PRIV = Buffer.from(privHex, 'hex');
const MAX_FRAME_PLAIN = 7900;
const MAX_CONN_PER_IP = 6, MAX_CONN_PER_MIN_PER_IP = 20, MAX_CMD_PER_MIN = 90, MAX_REQ_BYTES = 6000, IDLE_MS = 15 * 60 * 1000;
const perIp = new Map(); const recent = new Map();

function allow(ip) {
  const now = Date.now(); const arr = (recent.get(ip) || []).filter(t => now - t < 60000);
  if (arr.length >= MAX_CONN_PER_MIN_PER_IP) return false;
  if ((perIp.get(ip) || 0) >= MAX_CONN_PER_IP) return false;
  arr.push(now); recent.set(ip, arr); return true;
}
setInterval(() => { const now = Date.now(); for (const [ip, a] of recent) { const b = a.filter(t => now - t < 60000); if (b.length) recent.set(ip, b); else recent.delete(ip); } }, 60000).unref();

const server = net.createServer(sock => {
  const ip = sock.remoteAddress || '?';
  sock.setNoDelay(true);
  if (!allow(ip)) { sock.destroy(); return; }
  perIp.set(ip, (perIp.get(ip) || 0) + 1);
  if (process.env.DEBUG) console.log('connection from', ip);
  sock.on('close', () => process.env.DEBUG && console.log('closed', ip));
  sock.on('close', () => perIp.set(ip, Math.max(0, (perIp.get(ip) || 1) - 1)));
  sock.on('error', () => sock.destroy());
  sock.setTimeout(IDLE_MS, () => sock.destroy());
  let buf = Buffer.alloc(0), keys = null, rxN = 0, txN = 0, busy = false;
  const session = { token: null, email: null, cmds: [] };
  const hsTimer = setTimeout(() => { if (!keys) sock.destroy(); }, 10000);
  function send(status, text) {
    const body = Buffer.from(text, 'utf8');
    let off = 0; const parts = [];
    do { parts.push(body.subarray(off, off + MAX_FRAME_PLAIN)); off += MAX_FRAME_PLAIN; } while (off < body.length);
    parts.forEach((p, i) => {
      const last = i === parts.length - 1;
      const ct = wtp.seal(keys.s2c, txN++, Buffer.concat([Buffer.from(last ? 'L' : 'M'), p]));
      const hdr = Buffer.alloc(2); hdr.writeUInt16BE(ct.length);
      sock.write(Buffer.concat([hdr, ct]));
    });
  }
  async function handle(reqText) {
    const now = Date.now(); session.cmds = session.cmds.filter(t => now - t < 60000);
    if (session.cmds.length >= MAX_CMD_PER_MIN) return send('L', 'ERR Too many requests, slow down');
    session.cmds.push(now);
    const nl = reqText.indexOf('\n'); const cmd = (nl < 0 ? reqText : reqText.slice(0, nl)).trim().toUpperCase();
    const args = nl < 0 ? [] : reqText.slice(nl + 1).split('\n');
    try {
      let out;
      if (cmd === 'HELLO') out = 'OK wos-gateway 1';
      else if (cmd === 'FETCH') out = await web.fetchPage(args[0] || '');
      else out = await wmail.handle(cmd, args, session);
      send('L', out);
    } catch (e) { send('L', 'ERR ' + String(e && e.message || e).slice(0, 200)); }
  }
  async function pump() {
    if (busy) return; busy = true;
    try {
      for (;;) {
        if (!keys) {
          if (buf.length < 32) break;
          const C = buf.subarray(0, 32); buf = buf.subarray(32);
          const eph = wtp.newKeypair();
          const k1 = wtp.dh(STATIC_PRIV, C), k2 = wtp.dh(eph.priv, C);
          keys = wtp.deriveKeys(k1, k2, C, eph.pub); clearTimeout(hsTimer);
          sock.write(eph.pub);
          continue;
        }
        if (buf.length < 2) break;
        const len = buf.readUInt16BE(0);
        if (len < 17 || len > MAX_REQ_BYTES + 17) { if (process.env.DEBUG) console.log('bad length', len); sock.destroy(); return; }
        if (buf.length < 2 + len) break;
        const ct = buf.subarray(2, 2 + len); buf = buf.subarray(2 + len);
        let plain; try { plain = wtp.open(keys.c2s, rxN++, ct); } catch { if (process.env.DEBUG) console.log('bad frame from', ip); sock.destroy(); return; }
        await handle(plain.toString('utf8'));
      }
    } finally { busy = false; }
  }
  sock.on('data', d => { buf = Buffer.concat([buf, d]); if (buf.length > 20000) { sock.destroy(); return; } pump().catch(() => sock.destroy()); });
});
server.listen(PORT, '0.0.0.0', () => console.log('wos-gateway listening on ' + PORT));
