'use strict';
const $ = (s, r = document) => r.querySelector(s);
const h = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
};
const toast = (m) => { const t = h('div', { class: 'toast', text: m }); document.body.append(t); setTimeout(() => t.remove(), 3200); };
const fmt = (s) => { s = Math.floor(s); const m = Math.floor(s / 60); return String(m).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };
const bytes = (n) => n > 1e9 ? (n / 1e9).toFixed(2) + ' GB' : n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.round(n / 1e3) + ' KB';

// ---------- state ----------
let sources = [], chosen = null;
let opts = { sys: true, mic: false, fps: 30, quality: 'high', countdown: 3, cursor: true };
let rec = null;             // active recording {mr, chunks, stream, ctx, t0, paused, acc}
let take = null;            // finished recording {blob, url, duration}
let timer = null;

const app = $('#app');
const toolbar = h('div', { class: 'toolbar' });
const main = h('div', { class: 'main', style: 'flex:1;min-height:0;min-width:0;width:100%;overflow:hidden' });
const status = h('div', { class: 'status' });
app.append(toolbar, main, status);
const btn = (label, fn, cls = '') => h('button', { class: 'btn ' + cls, onclick: fn, text: label });

function setStatus(...parts) { status.textContent = ''; status.append(...parts.map((p) => typeof p === 'string' ? h('span', { text: p }) : p)); }

// ---------- setup screen ----------
async function loadSources() {
  try { sources = await window.host.captureSources(); } catch (_) { sources = []; }
  if (!chosen || !sources.find((s) => s.id === chosen)) chosen = sources[0] ? sources[0].id : null;
  render();
}
const BITRATE = { low: 2.5e6, medium: 5e6, high: 8e6, max: 16e6 };

function render() {
  clearInterval(timer); toolbar.textContent = ''; main.textContent = '';
  if (rec) return renderRecording();
  if (take) return renderReview();
  renderSetup();
}

function renderSetup() {
  toolbar.append(btn('Refresh sources', loadSources), h('span', { class: 'grow' }), btn('Start recording', start, 'primary'));
  const grid = h('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:10px;padding:14px;overflow:auto;flex:1;align-content:start' });
  const screens = sources.filter((s) => /^screen:/.test(s.id)), wins = sources.filter((s) => !/^screen:/.test(s.id));
  const tile = (s) => h('div', { class: 'list-item' + (s.id === chosen ? ' sel' : ''), style: 'padding:8px;border:1px solid var(--line,#444);border-radius:6px;cursor:pointer;display:flex;flex-direction:column;gap:6px;' + (s.id === chosen ? 'outline:2px solid #bdbdbd;' : ''), onclick: () => { chosen = s.id; render(); } },
    h('img', { src: s.thumb, style: 'width:100%;aspect-ratio:16/10;object-fit:contain;background:#1c1c1c;border-radius:4px' }),
    h('div', { style: 'font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis', text: s.name }));
  const left = h('div', { style: 'flex:1;min-width:0;display:flex;flex-direction:column;overflow:hidden' },
    h('h3', { style: 'padding:12px 14px 0', text: 'Screens' }), h('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:10px;padding:8px 14px' }, screens.map(tile)),
    h('h3', { style: 'padding:6px 14px 0', text: 'Windows' }), h('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:10px;padding:8px 14px;overflow:auto' }, wins.map(tile)),
    !sources.length ? h('div', { class: 'muted', style: 'padding:20px', text: 'No screens found. Press Refresh sources.' }) : null);
  const sel = (key, items, num) => { const s = h('select', { onchange: (e) => { opts[key] = num ? +e.target.value : e.target.value; } }, items.map(([v, t]) => h('option', { value: v, text: t, selected: String(opts[key]) === String(v) }))); return s; };
  const chk = (key, label) => h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: opts[key], onchange: (e) => { opts[key] = e.target.checked; } }), label);
  const side = h('div', { class: 'sidebar right', style: 'width:250px;overflow:auto' },
    h('h3', { text: 'Sound' }), chk('sys', 'Computer sound'), chk('mic', 'Microphone'),
    h('h3', { text: 'Picture' }), h('label', { class: 'field' }, 'Frame rate', sel('fps', [[15, '15 fps'], [30, '30 fps'], [60, '60 fps']], true)),
    h('label', { class: 'field' }, 'Quality', sel('quality', [['low', 'Small file'], ['medium', 'Balanced'], ['high', 'High'], ['max', 'Highest']])),
    chk('cursor', 'Show the mouse pointer'),
    h('h3', { text: 'Start' }), h('label', { class: 'field' }, 'Countdown', sel('countdown', [[0, 'None'], [3, '3 seconds'], [5, '5 seconds'], [10, '10 seconds']], true)),
    h('div', { class: 'muted', style: 'font-size:12px;margin-top:12px;line-height:1.6', text: 'Ctrl+Shift+R stops the recording when this window is in front.' }));
  main.append(left, side);
  setStatus(chosen ? 'Ready' : 'No source selected', h('span', { class: 'grow' }), 'Recordings are saved only where you choose');
}

// ---------- recording ----------
function pickMime() {
  for (const m of ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']) if (MediaRecorder.isTypeSupported(m)) return m;
  return '';
}
async function start() {
  if (!chosen) { toast('Choose a screen or window first'); return; }
  try {
    await window.host.captureChoose(chosen, opts.sys);
    const disp = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: opts.fps, cursor: opts.cursor ? 'always' : 'never' }, audio: opts.sys });
    let mic = null;
    if (opts.mic) { try { mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); } catch (_) { toast('Microphone not available, recording without it'); } }
    // mix audio tracks into one
    const tracks = [...disp.getVideoTracks()];
    let ctx = null;
    const aSrc = [disp, mic].filter((s) => s && s.getAudioTracks().length);
    if (aSrc.length) {
      ctx = new AudioContext(); const dest = ctx.createMediaStreamDestination();
      for (const s of aSrc) ctx.createMediaStreamSource(new MediaStream(s.getAudioTracks())).connect(dest);
      tracks.push(...dest.stream.getAudioTracks());
    }
    const stream = new MediaStream(tracks);
    if (opts.countdown) await countdown(opts.countdown);
    const mimeType = pickMime();
    const mr = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: BITRATE[opts.quality], audioBitsPerSecond: 160000 });
    const chunks = [];
    mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    mr.onstop = () => finish();
    const all = [disp, mic].filter(Boolean);
    rec = { mr, chunks, stream, ctx, all, t0: performance.now(), paused: false, acc: 0, size: 0 };
    disp.getVideoTracks()[0].addEventListener('ended', () => stopRec());
    mr.start(1000);
    render();
  } catch (e) {
    const m = e && e.name === 'NotAllowedError' ? 'Capture was not allowed' : (e && e.message) || String(e);
    toast('Could not start: ' + m);
  }
}
function countdown(n) {
  return new Promise((res) => {
    const o = h('div', { class: 'modal-back', style: 'background:rgba(0,0,0,.55)' }, h('div', { style: 'font-size:120px;font-weight:600;color:#eee', text: String(n) }));
    document.body.append(o);
    const id = setInterval(() => { n--; if (n <= 0) { clearInterval(id); o.remove(); res(); } else o.firstChild.textContent = String(n); }, 1000);
  });
}
const elapsed = () => rec ? (rec.acc + (rec.paused ? 0 : performance.now() - rec.t0)) / 1000 : 0;
function renderRecording() {
  const t = h('span', { style: 'font-family:Consolas,monospace;font-size:22px;min-width:90px', text: '00:00' });
  const dot = h('span', { style: 'width:10px;height:10px;border-radius:50%;background:#d0d0d0;display:inline-block;margin-right:8px', text: '' });
  const bPause = btn(rec.paused ? 'Resume' : 'Pause', togglePause);
  toolbar.append(dot, h('span', { text: rec.paused ? 'Paused' : 'Recording' }), t, h('span', { class: 'grow' }), bPause, btn('Stop and review', stopRec, 'primary'));
  main.append(h('div', { style: 'flex:1;display:flex;align-items:center;justify-content:center;text-align:center;color:#999;line-height:1.8' }, h('div', {}, h('div', { style: 'font-size:16px;color:#ddd', text: rec.paused ? 'Recording is paused' : 'Recording your screen' }), h('div', { text: 'You can minimize this window. Press Stop and review when you are done.' }))));
  const upd = () => { if (!rec) return; t.textContent = fmt(elapsed()); dot.style.opacity = rec.paused ? 0.3 : (Math.floor(elapsed()) % 2 ? 0.35 : 1); setStatus(rec.paused ? 'Paused' : 'Recording', h('span', { class: 'grow' }), 'Size so far ' + bytes(rec.chunks.reduce((a, c) => a + c.size, 0))); };
  upd(); timer = setInterval(upd, 500);
}
function togglePause() { if (!rec) return; if (rec.paused) { rec.mr.resume(); rec.t0 = performance.now(); rec.paused = false; } else { rec.mr.pause(); rec.acc += performance.now() - rec.t0; rec.paused = true; } render(); }
function stopRec() { if (!rec || rec.stopping) return; rec.stopping = true; rec.dur = elapsed(); try { if (rec.mr.state !== 'inactive') rec.mr.stop(); } catch (_) { finish(); } }
function finish() {
  if (!rec) return; const r = rec; rec = null; clearInterval(timer);
  r.stream.getTracks().forEach((t) => t.stop()); r.all.forEach((s) => s.getTracks().forEach((t) => t.stop())); if (r.ctx) r.ctx.close();
  const blob = new Blob(r.chunks, { type: 'video/webm' });
  if (take) URL.revokeObjectURL(take.url);
  take = { blob, url: URL.createObjectURL(blob), duration: r.dur || 0 };
  render();
}

// ---------- review & save ----------
function renderReview() {
  const v = h('video', { src: take.url, controls: true, style: 'max-width:100%;max-height:100%;background:#000' });
  const fm = h('select', {}, ...[['webm', 'WebM (original, fastest)'], ['mp4', 'MP4 (plays everywhere)'], ['gif', 'GIF (animated, first 30 seconds)'], ['mp3', 'MP3 (sound only)']].map(([k, t]) => h('option', { value: k, text: t })));
  const prog = h('div', { class: 'progress', style: 'display:none' }, h('div', { style: 'width:0%' }));
  const ps = prog.firstChild;
  window.host.onProgress((p) => { if (p && p.duration) ps.style.width = Math.min(100, (p.t / p.duration) * 100) + '%'; });
  const b = btn('Save', async () => { prog.style.display = ''; ps.style.width = '0%'; b.disabled = true; await save(fm.value); b.disabled = false; prog.style.display = 'none'; }, 'primary');
  toolbar.append(btn('New recording', discard), h('span', { class: 'grow' }), h('span', { class: 'muted', text: 'Format' }), fm, b);
  main.append(h('div', { style: 'flex:1;min-width:0;display:flex;flex-direction:column;padding:12px;gap:10px;overflow:hidden' }, h('div', { style: 'flex:1;min-height:0;display:flex;align-items:center;justify-content:center' }, v), prog));
  setStatus('Recorded ' + fmt(take.duration), h('span', { class: 'grow' }), bytes(take.blob.size) + ' as WebM');
}
function discard() { if (take && !confirm('Discard this recording?')) return; if (take) URL.revokeObjectURL(take.url); take = null; render(); loadSources(); }
const NAMES = { webm: ['WebM video', ['webm']], mp4: ['MP4 video', ['mp4']], gif: ['GIF', ['gif']], mp3: ['MP3 audio', ['mp3']] };
const ARGS = {
  mp4: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart'],
  mp3: ['-vn', '-c:a', 'libmp3lame', '-b:a', '192k'],
  gif: ['-t', '30', '-vf', 'fps=12,scale=720:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse', '-an'],
};
async function save(kind) {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const dest = await window.host.saveFile({ name: 'Recording ' + stamp + '.' + kind, filters: [NAMES[kind]] }); if (!dest) return;
  try {
    const buf = new Uint8Array(await take.blob.arrayBuffer());
    if (kind === 'webm') { await window.host.writeFile(dest.id, buf); }
    else {
      const t = await window.host.tempFile(buf, 'webm');
      try { await window.host.run({ args: ['-i', '{in0}', ...ARGS[kind], '{out}'], inputs: [t.id], out: dest.id, duration: take.duration }); } finally { window.host.removeFile(t.id); }
    }
    toast('Saved ' + dest.name);
  } catch (e) { toast('Save failed: ' + String(e.message || e).split('\n').pop().slice(0, 90)); }
}

document.addEventListener('keydown', (e) => { if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'r' && rec) { e.preventDefault(); stopRec(); } });
window.addEventListener('beforeunload', (e) => { if (rec || take) { e.preventDefault(); e.returnValue = ''; } });
loadSources();
