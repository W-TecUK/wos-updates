'use strict';
// Fetches a web page for W-OS 2 and turns it into a very simple line format:
//   TITLE text | H text | P text | LI text | LINK n url   (links appear inside text as [n])
const dns = require('node:dns').promises;
const net = require('node:net');
const https = require('node:https');
const http = require('node:http');

function isPrivate(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    return p[0] === 0 || p[0] === 10 || p[0] === 127 || (p[0] === 100 && p[1] >= 64 && p[1] < 128) || (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] < 32) || (p[0] === 192 && p[1] === 168) || (p[0] === 192 && p[1] === 0) || p[0] >= 224;
  }
  const l = ip.toLowerCase();
  if (l === '::1' || l === '::' || l.startsWith('fe80') || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('ff')) return true;
  if (l.startsWith('::ffff:')) return isPrivate(l.slice(7));
  return false;
}
async function safeLookup(host) {
  if (net.isIP(host)) { if (isPrivate(host)) throw new Error('That address is not allowed'); return host; }
  const res = await dns.lookup(host, { all: true });
  if (!res.length) throw new Error('Name not found');
  for (const r of res) if (isPrivate(r.address)) throw new Error('That address is not allowed');
  return res[0].address;
}
function getOnce(urlStr) {
  return new Promise(async (resolve, reject) => {
    let u; try { u = new URL(urlStr); } catch { return reject(new Error('Bad address')); }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return reject(new Error('Only http and https'));
    if (u.port && !['80', '443', '8080', '8443'].includes(u.port)) return reject(new Error('Port not allowed'));
    let ip; try { ip = await safeLookup(u.hostname.replace(/^\[|\]$/g, '')); } catch (e) { return reject(e); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({ host: ip, servername: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, method: 'GET',
      headers: { host: u.host, 'user-agent': 'Mozilla/5.0 (compatible; W-WideWeb/2.0; W-OS 2)', accept: 'text/html,text/plain;q=0.9,*/*;q=0.1', 'accept-encoding': 'identity', 'accept-language': 'en-GB,en;q=0.8' }, timeout: 15000 }, res => {
      const chunks = []; let n = 0;
      res.on('data', c => { n += c.length; if (n > 1500000) { req.destroy(); reject(new Error('Page too big')); } else chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), url: u.href }));
      res.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Timed out')); });
    req.on('error', reject); req.end();
  });
}
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', pound: '£', euro: '€', copy: '©', reg: '®', hellip: '...', ndash: '-', mdash: '-', lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"', bull: '*', middot: '.' };
function decode(s) {
  return s.replace(/&#x([0-9a-f]+);|&#(\d+);|&([a-z]+);/gi, (m, h, d, n) => {
    if (h || d) { const c = parseInt(h || d, h ? 16 : 10); return c < 128 || c === 163 ? String.fromCharCode(c) : (c === 8217 || c === 8216 ? "'" : c === 8220 || c === 8221 ? '"' : c === 8211 || c === 8212 ? '-' : ' '); }
    return ENT[n.toLowerCase()] ?? ' ';
  });
}
function simplify(html, baseUrl) {
  const links = [];
  let h = html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|noscript|svg|head|template|iframe|nav|footer)\b[\s\S]*?<\/\1>/gi, ' ');
  const tm = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html); const title = tm ? decode(tm[1]).replace(/\s+/g, ' ').trim() : '';
  h = h.replace(/<a\b[^>]*?href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi, (m, _a, d, s, u, inner) => {
    const href = d ?? s ?? u ?? ''; let abs; try { abs = new URL(decode(href), baseUrl).href; } catch { return inner; }
    if (!/^https?:/i.test(abs)) return inner; const t = inner.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!t) return ' '; if (links.length >= 300) return t; links.push(abs); return ' ' + t + '[' + links.length + '] ';
  });
  h = h.replace(/<(h[1-6])\b[^>]*>/gi, '\n#H ').replace(/<\/h[1-6]>/gi, '\n').replace(/<li\b[^>]*>/gi, '\n#L ').replace(/<(br|\/p|\/div|\/tr|\/section|\/article|p|div|tr|section|article|ul|ol|table|blockquote|pre)\b[^>]*>/gi, '\n#P ');
  h = h.replace(/<[^>]+>/g, '');
  const lines = []; let cur = 'P';
  for (const raw of decode(h).split('\n')) {
    let t = raw; let kind = 'P';
    if (t.startsWith('#H ')) { kind = 'H'; t = t.slice(3); } else if (t.startsWith('#L ')) { kind = 'LI'; t = t.slice(3); } else if (t.startsWith('#P ')) t = t.slice(3);
    t = t.replace(/#[HLP] /g, ' ').replace(/[^\x20-\x7e£]/g, ' ').replace(/\s+/g, ' ').trim();
    if (t) lines.push(kind + ' ' + t);
    if (lines.length > 900) break;
  }
  return 'OK\nTITLE ' + (title || baseUrl) + '\n' + lines.join('\n') + '\n' + links.map((l, i) => 'LINK ' + (i + 1) + ' ' + l).join('\n');
}
async function fetchPage(url) {
  url = url.trim(); if (!/^[a-z]+:\/\//i.test(url)) url = 'https://' + url;
  let res; let cur = url;
  for (let i = 0; i < 6; i++) {
    res = await getOnce(cur);
    if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.location) { cur = new URL(res.headers.location, cur).href; continue; }
    break;
  }
  if (res.status >= 400) return 'ERR The page replied ' + res.status;
  const ct = String(res.headers['content-type'] || '');
  const body = res.body.toString(/charset=iso-8859-1/i.test(ct) ? 'latin1' : 'utf8');
  if (/text\/plain/i.test(ct)) return 'OK\nTITLE ' + cur + '\n' + body.split('\n').slice(0, 900).map(l => 'P ' + l.replace(/[^\x20-\x7e]/g, ' ')).join('\n') + '\n';
  if (!/html|xml/i.test(ct) && ct) return 'ERR This kind of page cannot be shown (' + ct.split(';')[0] + ')';
  return simplify(body, cur);
}
async function fetchFile(url) {
  url = url.trim(); if (!/^[a-z]+:\/\//i.test(url)) url = 'https://' + url;
  let res; let cur = url;
  for (let i = 0; i < 6; i++) {
    res = await getOnce(cur);
    if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.location) { cur = new URL(res.headers.location, cur).href; continue; }
    break;
  }
  if (res.status >= 400) throw new Error('The address replied ' + res.status);
  if (res.body.length > 30000) throw new Error('That file is bigger than 30 KB. W-OS 2 files can be up to 32 KB.');
  const b = res.body;
  if (b.length > 3 && ((b[0] === 0x4d && b[1] === 0x5a) || (b[0] === 0x7f && b[1] === 0x45) || (b[0] === 0x50 && b[1] === 0x4b))) throw new Error('That is a program or archive, not a text file. Whistling Birdy brings in text files only.');
  return 'OK\n' + b.toString('utf8').replace(/\r/g, '').replace(/[^\n\t\x20-\x7e\u00a3]/g, ' ');
}
module.exports = { fetchPage, fetchFile, isPrivate };
