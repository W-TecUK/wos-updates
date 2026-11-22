// Local test: starts the gateway on a random port, connects as W-OS 2 would, and prints the replies.
const net = require('node:net'); const { spawn } = require('node:child_process'); const wtp = require('./wtp');
const kp = wtp.newKeypair(); const PORT = 9123;
const srv = spawn('node', ['server.js'], { env: { ...process.env, PORT, GATEWAY_PRIV: kp.priv.toString('hex') }, stdio: 'inherit' });
setTimeout(() => {
  const eph = wtp.newKeypair(); const sock = net.connect(PORT, '127.0.0.1'); let buf = Buffer.alloc(0), keys = null, rx = 0, tx = 0;
  sock.write(eph.pub);
  function req(t) { const ct = wtp.seal(keys.c2s, tx++, Buffer.from(t)); const h = Buffer.alloc(2); h.writeUInt16BE(ct.length); sock.write(Buffer.concat([h, ct])); }
  const queue = ['HELLO', 'FETCH\nhttp://127.0.0.1/', 'FETCH\nhttps://example.com/', 'WHOAMI'];
  let acc = '';
  sock.on('data', d => { buf = Buffer.concat([buf, d]);
    if (!keys) { if (buf.length < 32) return; const S = buf.subarray(0, 32); buf = buf.subarray(32); keys = wtp.deriveKeys(wtp.dh(eph.priv, kp.pub), wtp.dh(eph.priv, S), eph.pub, S); req(queue.shift()); }
    while (buf.length >= 2 && buf.length >= 2 + buf.readUInt16BE(0)) { const l = buf.readUInt16BE(0); const p = wtp.open(keys.s2c, rx++, buf.subarray(2, 2 + l)); buf = buf.subarray(2 + l);
      acc += p.subarray(1).toString(); if (p[0] === 76) { console.log('--- reply ---\n' + acc.slice(0, 600)); acc = ''; if (queue.length) req(queue.shift()); else { sock.end(); srv.kill(); process.exit(0); } } } });
  sock.on('error', e => { console.log('err', e.message); srv.kill(); });
}, 800);
