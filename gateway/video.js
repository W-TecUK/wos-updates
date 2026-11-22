'use strict';
// W-TV video: shows listed in shows.json are turned into small frames (160x90, 8 per second, 8-bit colour) plus 8 kHz sound.
const fs = require('fs'), path = require('path'), os = require('os'), { spawn } = require('child_process');
const FW = 160, FH = 90, FPS = 8, FSZ = FW * FH, CH_FRAMES = 6, CH_AUDIO = 6000, MAXSEC = 600;
const dir = path.join(os.tmpdir(), 'wtv'); try { fs.mkdirSync(dir, { recursive: true }); } catch {}
const jobs = new Map();
function ffmpegPath() { try { return require('ffmpeg-static') || 'ffmpeg'; } catch { return process.env.FFMPEG || 'ffmpeg'; } }
function shows() { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'shows.json'), 'utf8')); } catch { return []; } }
function prepare(i) {
  if (jobs.has(i)) return jobs.get(i);
  const s = shows()[i]; if (!s || !s.url) throw new Error('No such show');
  const vf = path.join(dir, 'v' + i + '.raw'), af = path.join(dir, 'a' + i + '.raw');
  const job = { state: 'preparing', vf, af, err: '' };
  jobs.set(i, job);
  const p = spawn(ffmpegPath(), ['-y', '-loglevel', 'error', '-i', s.url, '-t', String(MAXSEC),
    '-map', '0:v:0', '-vf', 'fps=' + FPS + ',scale=' + FW + ':' + FH + ':flags=fast_bilinear,format=rgb8', '-f', 'rawvideo', vf,
    '-map', '0:a:0?', '-ac', '1', '-ar', '8000', '-f', 'u8', af]);
  let err = ''; p.stderr.on('data', d => { err += d; });
  p.on('error', e => { job.state = 'failed'; job.err = 'Video is not available on this gateway'; });
  p.on('close', code => { if (code === 0) job.state = 'ready'; else { job.state = 'failed'; job.err = 'This show could not be prepared'; jobs.delete(i); } });
  return job;
}
function info(i) {
  const job = prepare(i);
  if (job.state === 'failed') { jobs.delete(i); throw new Error(job.err); }
  let chunks = 0; try { chunks = Math.ceil(fs.statSync(job.vf).size / FSZ / CH_FRAMES); } catch {}
  return 'OK\n' + job.state + '\t' + chunks + '\t' + FW + '\t' + FH + '\t' + FPS;
}
function chunk(i, n) {
  const job = jobs.get(i); if (!job) throw new Error('Open the show first');
  const fd = fs.openSync(job.vf, 'r'); const v = Buffer.alloc(FSZ * CH_FRAMES);
  const got = fs.readSync(fd, v, 0, v.length, n * v.length); fs.closeSync(fd);
  if (got <= 0) return Buffer.from('OK\n');
  let a = Buffer.alloc(CH_AUDIO, 128);
  try { const fa = fs.openSync(job.af, 'r'); fs.readSync(fa, a, 0, CH_AUDIO, n * CH_AUDIO); fs.closeSync(fa); } catch {}
  const frames = Math.floor(got / FSZ);
  const head = Buffer.from('OK\n' + frames + '\n'); // frame count line
  return Buffer.concat([head, v.subarray(0, frames * FSZ), a]);
}
module.exports = { info, chunk, shows, CH_FRAMES, CH_AUDIO };
