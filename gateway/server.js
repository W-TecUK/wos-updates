'use strict';
// W-OS gateway. Accepts WTP connections from W-OS 2 and does web / W-Mail / W-Life requests for it.
// Safety: key pinned in the OS, per-IP and per-connection rate limits, no private/internal addresses,
// credentials and tokens only live in memory for the life of one connection, nothing is written to disk.
const net = require('node:net');
const dns = require('node:dns').promises;
const wtp = require('./wtp');
const web = require('./web');
const wmail = require('./wmail');
const jenny = require('./jenny');
const conv = require('./convert');
const video = require('./video');


async function place(q) {
  q = String(q).replace(/[\r\n\t]+/g, ' ').slice(0, 100).trim();
  if (!q) throw new Error('Type a place name');
  const res = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=6&q=' + encodeURIComponent(q), { headers: { 'user-agent': 'WOS2-gateway/1.0 (maps text search)' }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error('The place search is not answering');
  const j = await res.json();
  return 'OK\n' + j.map(p => String(p.display_name || '').replace(/[^\x20-\x7e\u00a3]/g, ' ').slice(0, 150) + '\t' + Number(p.lat).toFixed(4) + '\t' + Number(p.lon).toFixed(4)).join('\n');
}

function shows() {
  let list = [];
  try { list = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'shows.json'), 'utf8')); } catch {}
  const c = x => String(x ?? '').replace(/[\t\r\n]+/g, ' ').slice(0, 200);
  return 'OK\n' + list.map((s, i) => [c(s.title), c(s.about), s.free ? 'Free' : 'W-Life', String(i)].join('\t')).join('\n');
}

let newsCache = { t: 0, v: '' };
async function news() {
  if (Date.now() - newsCache.t < 5 * 60 * 1000 && newsCache.v) return newsCache.v;
  const res = await fetch('https://feeds.bbci.co.uk/news/rss.xml', { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error('The news feed is not answering');
  const xml = await res.text();
  const dec = x => x.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/[^\x20-\x7e\u00a3]/g, ' ').trim();
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 20).map(m => {
    const t = (m[1].match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
    const d = (m[1].match(/<description>([\s\S]*?)<\/description>/) || [])[1] || '';
    return dec(t).slice(0, 100) + '\t' + dec(d).slice(0, 200);
  });
  newsCache = { t: Date.now(), v: 'OK\n' + items.join('\n') };
  return newsCache.v;
}

const PORT = parseInt(process.env.PORT || '9000', 10);
const fs = require('fs');
const KEY_FILE = process.env.KEY_FILE || '/data/gateway.key';
let privHex = process.env.GATEWAY_PRIV;
if (!privHex || privHex.length !== 64) {
  try { privHex = fs.readFileSync(KEY_FILE, 'utf8').trim(); } catch (e) { privHex = ''; }
}
if (!privHex || privHex.length !== 64) {
  const kp = wtp.newKeypair();
  privHex = kp.priv.toString('hex');
  try { fs.mkdirSync(require('path').dirname(KEY_FILE), { recursive: true }); fs.writeFileSync(KEY_FILE, privHex, { mode: 0o600 }); }
  catch (e) { console.log('Cannot save key file (' + e.message + '). Mount a volume or set GATEWAY_PRIV.'); process.exit(1); }
  console.log('Generated a new gateway key (private half saved to the key file only).');
}
console.log('GATEWAY PUBLIC KEY = ' + wtp.rawPub(require('node:crypto').createPublicKey(wtp.privFromRaw(Buffer.from(privHex, 'hex')))).toString('hex'));
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
    const body = Buffer.isBuffer(text) ? text : Buffer.from(text, 'utf8');
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
      else if (cmd === 'GETFILE') out = await web.fetchFile(args[0] || '');
      else if (cmd === 'CONVERT') out = 'OK\n' + conv.convert((args[0] || '').trim(), args.slice(1).join('\n'));
      else if (cmd === 'VINFO') out = video.info(parseInt(args[0], 10) || 0);
      else if (cmd === 'VCHUNK') out = video.chunk(parseInt(args[0], 10) || 0, parseInt(args[1], 10) || 0);
      else if (cmd === 'SHOWS') out = shows();
      else if (cmd === 'NEWS') out = await news();
      else if (cmd === 'PLACE') out = await place(args[0] || '');
      else if (cmd === 'FETCH') out = await web.fetchPage(args[0] || '');
      else if (cmd.startsWith('J')) { out = await jenny.handle(cmd, args, session); if (out === null) out = 'ERR Unknown command'; }
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
