'use strict';
// Converters for W-OS 2: turn small source files into Satisfaction apps (appView / appPress).
// Hush-Link: simple SwiftUI.  Penguin: simple shell and Python print scripts.  Pane: simple Windows .bat files.
const q = s => String(s).replace(/\\/g, '').replace(/"/g, "'").replace(/[{}]/g, '(').replace(/[^\x20-\x7e\u00a3]/g, ' ');
function binaryCheck(src, kind) {
  const b = String(src).slice(0, 4);
  if (b.startsWith('MZ')) return 'This is a Windows program (.exe). Pane can convert .bat files, not compiled programs. A compiled program has no source to translate.';
  if (b.startsWith('\x7fELF')) return 'This is a compiled Linux program. Penguin can convert shell and Python print scripts, not compiled programs. A compiled program has no source to translate.';
  if (/^(\xcf\xfa|\xca\xfe|\xfe\xed)/.test(b)) return 'This is a compiled Mac program. Hush-Link can convert simple SwiftUI source, not compiled programs.';
  if (/[\x00-\x08]/.test(String(src).slice(0, 200))) return 'This file is not text.';
  return null;
}
// interpolation helpers: turn a text with variables into a Satisfaction string expression
function expr(text, vars, re) {
  const parts = []; let last = 0, m;
  re.lastIndex = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push('"' + q(text.slice(last, m.index)) + '"');
    const v = m[1];
    parts.push(vars.has(v) ? 'str(' + v + ')' : '"' + q(m[0]) + '"');
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push('"' + q(text.slice(last)) + '"');
  return parts.length ? parts.join(' + ') : '""';
}
function build(title, lines, state, press, notes) {
  let out = '// ' + title + ' (converted by W-OS 2)\n';
  for (const [n, v] of state) out += 'var ' + n + ' = ' + v + '\n';
  out += 'func appView() {\n  var y = 330\n';
  for (const l of lines) {
    if (l.t === 'text') out += '  text(' + l.e + ', ' + (l.big ? 33 : 28) + ', dx(476), dy(y), 0x1E1E1E, 0)\n  y = y + ' + (l.big ? 56 : 42) + '\n';
    else if (l.t === 'button') out += '  btn(' + l.id + ', ' + l.e + ', dx(476), dy(y), 260)\n  y = y + 76\n';
  }
  if (notes.length) { out += '  y = y + 20\n  text("Not converted:", 26, dx(476), dy(y), 0xC04040, 0)\n  y = y + 34\n'; for (const n of notes.slice(0, 8)) out += '  text("' + q(n).slice(0, 70) + '", 26, dx(476), dy(y), 0x777777, 0)\n  y = y + 30\n'; }
  out += '}\nfunc appPress(id) {\n' + (press.length ? press.map(p => '  if id == ' + p.id + ' {\n    ' + p.body + '\n  }\n').join('') : '') + '}\n';
  return out;
}
function actionOf(a, vars) {
  a = a.trim(); let m;
  if ((m = a.match(/^(\w+)\s*\+=\s*(-?\d+)$/))) return m[1] + ' = ' + m[1] + ' + ' + m[2];
  if ((m = a.match(/^(\w+)\s*-=\s*(-?\d+)$/))) return m[1] + ' = ' + m[1] + ' - ' + m[2];
  if ((m = a.match(/^(\w+)\s*=\s*(-?\d+)$/))) return m[1] + ' = ' + m[2];
  if ((m = a.match(/^(\w+)\s*=\s*"([^"]*)"$/))) return m[1] + ' = "' + q(m[2]) + '"';
  if ((m = a.match(/^(\w+)\s*\.toggle\(\)$/)) || (m = a.match(/^(\w+)\s*=\s*!\s*(\w+)$/))) return m[1] + ' = 1 - ' + m[1];
  return null;
}
function hushlink(src) {
  const vars = new Set(), state = [], lines = [], press = [], notes = []; let id = 5001; let last = null;
  for (let raw of src.split('\n')) {
    const l = raw.trim(); if (!l || l.startsWith('//') || /^(import|struct|var body|some View|\}|\{|VStack|HStack|ZStack|Spacer|\.padding|@main|#Preview|NavigationStack|List|Form|Group)/.test(l) && !/^Text|^Button/.test(l)) {
      if (l && /^\.font\(\.(title|largeTitle|headline|title2)/.test(l) && last) last.big = true;
      continue;
    }
    let m;
    if ((m = l.match(/^\.font\(\.(\w+)\)/))) { if (last && /title|headline/i.test(m[1])) last.big = true; continue; }
    if ((m = l.match(/^@State\s+(?:private\s+)?var\s+(\w+)\s*(?::\s*\w+)?\s*=\s*(.+)$/))) {
      let v = m[2].trim(); if (v === 'false') v = '0'; else if (v === 'true') v = '1';
      if (!/^-?\d+$/.test(v) && !/^".*"$/.test(v)) { notes.push('state ' + m[1] + ' (value type)'); continue; }
      vars.add(m[1]); state.push([m[1], v.replace(/[{}\\]/g, '')]); continue;
    }
    if ((m = l.match(/^Text\("(.*)"\)/))) { last = { t: 'text', e: expr(m[1], vars, /\\\((\w+)\)/g), big: /\.font\(\.(title|largeTitle|headline|title2)/.test(l) }; lines.push(last); continue; }
    if ((m = l.match(/^Button\("([^"]*)"\)\s*\{(.*?)\}?$/)) || (m = l.match(/^Button\("([^"]*)",\s*action:\s*\{(.*?)\}\)/))) {
      const body = actionOf(m[2], vars);
      if (body) { lines.push({ t: 'button', id, e: '"' + q(m[1]) + '"' }); press.push({ id, body }); id++; }
      else notes.push('button ' + m[1] + ': action not supported');
      last = null; continue;
    }
    if ((m = l.match(/^(Toggle|Slider|TextField|Image|Picker|NavigationLink|Map|List)\b/))) { notes.push(m[1] + ' is not supported'); continue; }
    if (/^\w+\s*\(/.test(l) || /^func\b/.test(l)) notes.push(l.slice(0, 50));
  }
  if (!lines.length) throw new Error('No Text or Button found. Hush-Link converts simple SwiftUI with Text and Button.');
  return build('Hush-Link', lines, state, press, notes);
}
function scriptApp(src, kind) {
  const vars = new Set(), state = [], lines = [], notes = [];
  for (let raw of src.split('\n')) {
    let l = raw.trim(); if (!l || l.startsWith('#!') ) continue; let m;
    if (kind === 'penguin') {
      if (l.startsWith('#')) continue;
      if ((m = l.match(/^echo\s+(?:-[ne]+\s+)?"(.*)"$/)) || (m = l.match(/^echo\s+'(.*)'$/)) || (m = l.match(/^echo\s+(.*)$/)) || (m = l.match(/^print\("(.*)"\)$/)) || (m = l.match(/^print\('(.*)'\)$/))) { lines.push({ t: 'text', e: expr(m[1], vars, /\$\{?(\w+)\}?/g) }); continue; }
      if ((m = l.match(/^(\w+)=("?)(-?\w[^"]*)\2$/)) || (m = l.match(/^(\w+)\s*=\s*"?(-?\d+)"?$/))) { const v = m[m.length - 1]; vars.add(m[1]); state.push([m[1], /^-?\d+$/.test(v) ? v : '"' + q(v) + '"']); continue; }
      if (/^(sleep|clear|set |exit|cd )/.test(l)) continue;
    } else {
      if (/^(@echo off|echo off|cls|pause|rem\b|::|exit|setlocal|endlocal)/i.test(l)) continue;
      if ((m = l.match(/^title\s+(.*)$/i))) { lines.push({ t: 'text', e: '"' + q(m[1]) + '"', big: true }); continue; }
      if ((m = l.match(/^echo\.?\s*(.*)$/i))) { lines.push({ t: 'text', e: expr(m[1], vars, /%(\w+)%/g) }); continue; }
      if ((m = l.match(/^set\s+(\w+)=(.*)$/i))) { const v = m[2].trim(); vars.add(m[1]); state.push([m[1], /^-?\d+$/.test(v) ? v : '"' + q(v) + '"']); continue; }
    }
    notes.push(l.slice(0, 60));
  }
  if (!lines.length) throw new Error(kind === 'penguin' ? 'No echo or print lines found. Penguin converts simple scripts that print text.' : 'No echo lines found. Pane converts simple .bat files that print text.');
  return build(kind === 'penguin' ? 'Penguin' : 'Pane', lines, state, [], notes);
}
function convert(kind, src) {
  src = String(src);
  const bad = binaryCheck(src, kind); if (bad) throw new Error(bad);
  if (kind === 'hush') return hushlink(src);
  if (kind === 'penguin' || kind === 'pane') return scriptApp(src, kind);
  throw new Error('Unknown converter');
}
module.exports = { convert };
