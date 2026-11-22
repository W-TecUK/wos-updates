'use strict';
// JennyAI (older Jenny for W-OS 2). Needs a paid Jenny plan. The Jenny token is kept in memory for this connection only.
const API = process.env.JENNY_API || 'https://jenny-backend-production-1ae0.up.railway.app';
const clean = (s, n = 200) => String(s ?? '').replace(/[\t\r\n]+/g, ' ').slice(0, n);
async function jcall(method, path, token, body, ms = 25000) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;
  const res = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(ms) });
  return res;
}
async function handle(cmd, a, s) {
  switch (cmd) {
    case 'JLOGIN': {
      const res = await jcall('POST', '/auth/login', null, { email: clean(a[0]), password: String(a[1] || '').slice(0, 200) });
      if (!res.ok) throw new Error(res.status === 401 ? 'Wrong Jenny email or password' : 'Jenny replied ' + res.status);
      const t = (await res.json()).access_token;
      const me = await jcall('GET', '/auth/me', t);
      const u = me.ok ? await me.json() : {};
      const paid = !!(u.entitlements && u.entitlements.unlimited_messages);
      if (!paid) throw new Error('JennyAI on W-OS 2 needs a Jenny Pro plan. Your account is on the free plan.');
      s.jtoken = t; s.jconv = null; return 'OK ' + clean(u.email || a[0], 80);
    }
    case 'JLOGOUT': s.jtoken = null; s.jconv = null; return 'OK';
    case 'JNEW': s.jconv = null; return 'OK';
    case 'JCHAT': {
      if (!s.jtoken) throw new Error('Not signed in');
      const msg = clean(a.join(' '), 1500);
      const res = await jcall('POST', '/chat', s.jtoken, { message: msg, conversation_id: s.jconv || undefined }, 85000);
      if (res.status === 429) throw new Error('You have reached the Jenny message limit for today.');
      if (!res.ok) throw new Error('Jenny replied ' + res.status);
      const text = await res.text();
      let out = '', ev = '';
      for (const line of text.split(/\r?\n/)) {
        if (line.startsWith('event:')) ev = line.slice(6).trim();
        else if (line.startsWith('data:')) {
          let d; try { d = JSON.parse(line.slice(5)); } catch { continue; }
          if (ev === 'chunk' && d.text) out += d.text;
          else if (ev === 'done' && d.conversation_id) s.jconv = d.conversation_id;
          else if (ev === 'error') throw new Error(clean(d.message, 120));
        }
      }
      return 'OK\n' + out.replace(/[^\n\x20-\x7e£]/g, ' ').slice(0, 6500);
    }
    default: return null;
  }
}
module.exports = { handle };
