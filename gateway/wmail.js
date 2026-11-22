'use strict';
// W-Mail / W-Life account commands. The sign-in token is kept in memory for this one connection only.
const API = process.env.WMAIL_API || 'https://api.wmail.life';
function clean(s, n = 200) { return String(s ?? '').replace(/[\t\r\n]+/g, ' ').slice(0, n); }
async function call(method, path, token, body) {
  const headers = { 'x-wmail-app': '1', 'content-type': 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;
  const res = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(25000) });
  let data = null; try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error((data && data.message) || ('Server replied ' + res.status));
  return data;
}
function need(session) { if (!session.token) throw new Error('Not signed in'); return session.token; }
async function handle(cmd, a, s) {
  switch (cmd) {
    case 'LOGIN': { const r = await call('POST', '/api/v1/auth/login', null, { email: clean(a[0]), password: String(a[1] || '').slice(0, 200) }); s.token = r.token; s.email = r.email; return 'OK ' + r.email; }
    case 'LOGOUT': { if (s.token) { try { await call('POST', '/api/v1/auth/logout', s.token); } catch {} } s.token = null; s.email = null; return 'OK'; }
    case 'WHOAMI': return s.email ? 'OK ' + s.email : 'ERR Not signed in';
    case 'FOLDERS': { const r = await call('GET', '/api/v1/mail/folders', need(s)); return 'OK\n' + r.map(f => clean(f.path) + '\t' + clean(f.name) + '\t' + clean(f.specialUse || '')).join('\n'); }
    case 'MLIST': { const r = await call('GET', '/api/v1/mail/messages?folder=' + encodeURIComponent(clean(a[0] || 'INBOX')), need(s));
      return 'OK\n' + r.map(m => [m.uid, clean(m.subject || '(no subject)', 90), clean((m.from || [])[0] || '', 60), clean(m.date ? new Date(m.date).toISOString().slice(0, 16).replace('T', ' ') : ''), (m.flags || []).includes('\\Seen') ? '1' : '0'].join('\t')).join('\n'); }
    case 'MGET': { const r = await call('GET', '/api/v1/mail/messages/' + encodeURIComponent(clean(a[0])) + '?folder=' + encodeURIComponent(clean(a[1] || 'INBOX')), need(s));
      let text = r.text || (r.html ? String(r.html).replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ') : '');
      text = String(text).replace(/\r/g, '').replace(/[^\n\x20-\x7e£]/g, ' ').slice(0, 20000);
      return 'OK\nFROM ' + clean(r.from, 100) + '\nTO ' + clean((r.to || []).join(', '), 150) + '\nSUBJECT ' + clean(r.subject, 150) + '\nDATE ' + clean(r.date, 40) + '\nATTACH ' + (r.attachments || []).length + '\n\n' + text; }
    case 'MSEND': { await call('POST', '/api/v1/mail/send', need(s), { to: clean(a[0], 300), subject: clean(a[1], 200), text: a.slice(2).join('\n').slice(0, 20000) }); return 'OK'; }
    case 'MDEL': { await call('POST', '/api/v1/mail/messages/' + encodeURIComponent(clean(a[0])) + '/move', need(s), { folder: clean(a[1] || 'INBOX'), to: 'Trash' }); return 'OK'; }
    case 'CHATS': { const r = await call('GET', '/api/v1/messages/threads', need(s)); return 'OK\n' + JSON.stringify(r).slice(0, 7000); }
    case 'CHAT': { const r = await call('GET', '/api/v1/messages?with=' + encodeURIComponent(clean(a[0])), need(s)); return 'OK\n' + JSON.stringify(r).slice(0, 7000); }
    case 'CHATSEND': { await call('POST', '/api/v1/messages', need(s), { to: clean(a[0]), body: clean(a.slice(1).join('\n'), 2000) }); return 'OK'; }
    default: return 'ERR Unknown command';
  }
}
module.exports = { handle };
