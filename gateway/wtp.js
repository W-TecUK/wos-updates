// WTP: the W-OS tunnel protocol. A small authenticated, encrypted channel (like Noise "NK").
//  client -> server : 32 bytes  client ephemeral X25519 public key C
//  server -> client : 32 bytes  server ephemeral X25519 public key S
//  k1 = X25519(c, Sstatic) , k2 = X25519(c, S)
//  master = SHA-256(k1 || k2 || C || S || "WTP1")
//  key_c2s = SHA-256(master || 0x01) , key_s2c = SHA-256(master || 0x02)
//  frames: 2-byte big-endian length, then ChaCha20-Poly1305 ciphertext+tag (nonce = 4 zero bytes + 8-byte LE counter, no AAD)
const crypto = require('node:crypto');

const X25519_PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const X25519_SPKI = Buffer.from('302a300506032b656e032100', 'hex');
function privFromRaw(raw) { return crypto.createPrivateKey({ key: Buffer.concat([X25519_PKCS8, raw]), format: 'der', type: 'pkcs8' }); }
function pubFromRaw(raw) { return crypto.createPublicKey({ key: Buffer.concat([X25519_SPKI, raw]), format: 'der', type: 'spki' }); }
function rawPub(keyObj) { return keyObj.export({ format: 'der', type: 'spki' }).subarray(12); }
function dh(privRaw, pubRaw) { return crypto.diffieHellman({ privateKey: privFromRaw(privRaw), publicKey: pubFromRaw(pubRaw) }); }
function newKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  return { pub: rawPub(publicKey), priv: privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(16) };
}
const sha256 = (...b) => crypto.createHash('sha256').update(Buffer.concat(b)).digest();
function deriveKeys(k1, k2, C, S) {
  const master = sha256(k1, k2, C, S, Buffer.from('WTP1'));
  return { c2s: sha256(master, Buffer.from([1])), s2c: sha256(master, Buffer.from([2])) };
}
function nonce(counter) { const n = Buffer.alloc(12); n.writeBigUInt64LE(BigInt(counter), 4); return n; }
function seal(key, counter, plain) {
  const c = crypto.createCipheriv('chacha20-poly1305', key, nonce(counter), { authTagLength: 16 });
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([ct, c.getAuthTag()]);
}
function open(key, counter, data) {
  if (data.length < 16) throw new Error('short frame');
  const d = crypto.createDecipheriv('chacha20-poly1305', key, nonce(counter), { authTagLength: 16 });
  d.setAuthTag(data.subarray(data.length - 16));
  return Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]);
}
module.exports = { newKeypair, dh, deriveKeys, seal, open, privFromRaw, pubFromRaw, rawPub };
