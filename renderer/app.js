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
let opts = { sys: true, mic: false, fps: 30, quality: 'high', countdown: 3, cursor: true, cam: false, camPos: 'br', camSize: 22, draw: true };
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
    h('h3', { text: 'Webcam' }), chk('cam', 'Show webcam in the corner'),
    h('label', { class: 'field' }, 'Corner', sel('camPos', [['br', 'Bottom right'], ['bl', 'Bottom left'], ['tr', 'Top right'], ['tl', 'Top left']])),
    h('label', { class: 'field' }, 'Size', sel('camSize', [[16, 'Small'], [22, 'Medium'], [30, 'Large']], true)),
    h('h3', { text: 'Drawing' }), chk('draw', 'Draw on the recording'),
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
  const grabbed = [];
  try {
    await window.host.captureChoose(chosen, opts.sys);
    const disp = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: opts.fps, cursor: opts.cursor ? 'always' : 'never' }, audio: opts.sys });
    grabbed.push(disp);
    let mic = null;
    if (opts.mic) { try { mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); grabbed.push(mic); } catch (_) { toast('Microphone not available, recording without it'); } }
    // mix audio tracks into one
    const tracks = [...disp.getVideoTracks()];
    let ctx = null;
    const aSrc = [disp, mic].filter((s) => s && s.getAudioTracks().length);
    if (aSrc.length) {
      ctx = new AudioContext(); const dest = ctx.createMediaStreamDestination();
      for (const s of aSrc) ctx.createMediaStreamSource(new MediaStream(s.getAudioTracks())).connect(dest);
      tracks.push(...dest.stream.getAudioTracks());
    }
    let comp = null, camStream = null;
    if (opts.cam) { try { camStream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } }); grabbed.push(camStream); } catch (_) { toast('Webcam not available, recording without it'); } }
    if (camStream || opts.draw) { comp = makeComposite(disp, camStream); tracks[0] = comp.canvas.captureStream(opts.fps).getVideoTracks()[0]; }
    const stream = new MediaStream(tracks);
    if (opts.countdown) await countdown(opts.countdown);
    const mimeType = pickMime();
    const mr = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: BITRATE[opts.quality], audioBitsPerSecond: 160000 });
    const chunks = [];
    mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    mr.onstop = () => finish();
    const all = [disp, mic, camStream].filter(Boolean);
    rec = { mr, chunks, stream, ctx, all, comp, t0: performance.now(), paused: false, acc: 0, size: 0 };
    disp.getVideoTracks()[0].addEventListener('ended', () => stopRec());
    mr.start(1000);
    render();
  } catch (e) {
    for (const s of grabbed) for (const t of s.getTracks()) t.stop();
    const m = e && e.name === 'NotAllowedError' ? 'Capture was not allowed' : (e && e.message) || String(e);
    toast('Could not start: ' + m);
  }
}
// Composite: screen + optional webcam bubble + pen strokes, drawn onto one canvas that is recorded.
function makeComposite(disp, cam) {
  const vt = disp.getVideoTracks()[0], st = vt.getSettings();
  const canvas = document.createElement('canvas'); canvas.width = st.width || 1920; canvas.height = st.height || 1080;
  const g = canvas.getContext('2d');
  const vs = h('video', { muted: true, playsinline: true }); vs.muted = true; vs.srcObject = new MediaStream([vt]); vs.play().catch(() => {});
  let vc = null; if (cam) { vc = h('video', { muted: true, playsinline: true }); vc.muted = true; vc.srcObject = cam; vc.play().catch(() => {}); }
  const c = { canvas, strokes: [], tool: 'pen', cur: null, stop: false };
  const draw = () => {
    if (c.stop) return;
    if (vs.readyState >= 2) g.drawImage(vs, 0, 0, canvas.width, canvas.height);
    for (const s of c.strokes.concat(c.cur ? [c.cur] : [])) paintStroke(g, s, canvas.width);
    if (vc && vc.readyState >= 2 && vc.videoWidth) {
      const d = Math.round(canvas.height * opts.camSize / 100), m = Math.round(d * 0.12);
      const x = opts.camPos.includes('l') ? m : canvas.width - d - m, y = opts.camPos.includes('t') ? m : canvas.height - d - m;
      g.save(); g.beginPath(); g.arc(x + d / 2, y + d / 2, d / 2, 0, Math.PI * 2); g.clip();
      const sc = Math.max(d / vc.videoWidth, d / vc.videoHeight), w = vc.videoWidth * sc, hh = vc.videoHeight * sc;
      g.translate(x + d / 2, y + d / 2); g.scale(-1, 1); g.drawImage(vc, -w / 2, -hh / 2, w, hh); g.restore();
      g.beginPath(); g.arc(x + d / 2, y + d / 2, d / 2, 0, Math.PI * 2); g.lineWidth = Math.max(3, d / 40); g.strokeStyle = '#e6e6e6'; g.stroke();
    }
  };
  c.timer = setInterval(draw, Math.round(1000 / Math.max(opts.fps, 10)));
  c.dispose = () => { c.stop = true; clearInterval(c.timer); vs.srcObject = null; if (vc) vc.srcObject = null; };
  return c;
}
function paintStroke(g, s, w) {
  const p = s.pts; if (!p.length) return;
  const lw = Math.max(3, w / 400);
  g.save(); g.lineCap = 'round'; g.lineJoin = 'round';
  if (s.tool === 'hl') { g.globalAlpha = 0.35; g.strokeStyle = '#f2f2f2'; g.lineWidth = lw * 6; }
  else { g.strokeStyle = '#ffffff'; g.lineWidth = lw; g.shadowColor = 'rgba(0,0,0,.6)'; g.shadowBlur = lw; }
  g.beginPath();
  if (s.tool === 'arrow') {
    const a = p[0], b = p[p.length - 1]; g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]);
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]), L = lw * 6;
    g.moveTo(b[0], b[1]); g.lineTo(b[0] - L * Math.cos(ang - 0.45), b[1] - L * Math.sin(ang - 0.45));
    g.moveTo(b[0], b[1]); g.lineTo(b[0] - L * Math.cos(ang + 0.45), b[1] - L * Math.sin(ang + 0.45));
  } else { g.moveTo(p[0][0], p[0][1]); for (const q of p) g.lineTo(q[0], q[1]); if (p.length === 1) g.lineTo(p[0][0] + 0.1, p[0][1]); }
  g.stroke(); g.restore();
}
function drawPanel() {
  const c = rec.comp; if (!c) return null;
  const view = c.canvas; view.style.cssText = 'max-width:100%;max-height:100%;background:#000;cursor:crosshair;touch-action:none';
  const pos = (e) => { const r = view.getBoundingClientRect(); return [(e.clientX - r.left) * view.width / r.width, (e.clientY - r.top) * view.height / r.height]; };
  view.onpointerdown = (e) => { if (!opts.draw) return; view.setPointerCapture(e.pointerId); c.cur = { tool: c.tool, pts: [pos(e)] }; };
  view.onpointermove = (e) => { if (c.cur) c.cur.pts.push(pos(e)); };
  view.onpointerup = () => { if (c.cur) { c.strokes.push(c.cur); c.cur = null; } };
  const tb = (id, label) => h('button', { class: 'btn' + (c.tool === id ? ' primary' : ''), text: label, onclick: () => { c.tool = id; render(); } });
  const bar = opts.draw ? h('div', { style: 'display:flex;gap:6px;align-items:center;justify-content:center;padding-bottom:8px' }, tb('pen', 'Pen'), tb('hl', 'Highlighter'), tb('arrow', 'Arrow'),
    h('button', { class: 'btn', text: 'Undo', onclick: () => c.strokes.pop() }), h('button', { class: 'btn', text: 'Clear', onclick: () => { c.strokes.length = 0; } })) : null;
  return h('div', { style: 'flex:1;min-width:0;display:flex;flex-direction:column;padding:10px;overflow:hidden' }, bar,
    h('div', { style: 'flex:1;min-height:0;display:flex;align-items:center;justify-content:center' }, view),
    h('div', { class: 'muted', style: 'font-size:12px;text-align:center;padding-top:6px', text: 'What you see here is what is being recorded. Drawings appear in the recording.' }));
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
  const dp = drawPanel();
  if (dp) main.append(dp); else main.append(h('div', { style: 'flex:1;display:flex;align-items:center;justify-content:center;text-align:center;color:#999;line-height:1.8' }, h('div', {},h('div', { style: 'font-size:16px;color:#ddd', text: rec.paused ? 'Recording is paused' : 'Recording your screen' }), h('div', { text: 'You can minimize this window. Press Stop and review when you are done.' }))));
  const upd = () => { if (!rec) return; t.textContent = fmt(elapsed()); dot.style.opacity = rec.paused ? 0.3 : (Math.floor(elapsed()) % 2 ? 0.35 : 1); setStatus(rec.paused ? 'Paused' : 'Recording', h('span', { class: 'grow' }), 'Size so far ' + bytes(rec.chunks.reduce((a, c) => a + c.size, 0))); };
  upd(); timer = setInterval(upd, 500);
}
function togglePause() { if (!rec) return; if (rec.paused) { rec.mr.resume(); rec.t0 = performance.now(); rec.paused = false; } else { rec.mr.pause(); rec.acc += performance.now() - rec.t0; rec.paused = true; } render(); }
function stopRec() { if (!rec || rec.stopping) return; rec.stopping = true; rec.dur = elapsed(); try { if (rec.mr.state !== 'inactive') rec.mr.stop(); } catch (_) { finish(); } }
function finish() {
  if (!rec) return; const r = rec; rec = null; clearInterval(timer);
  if (r.comp) r.comp.dispose();
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
  // trim: start/end sliders; applied when saving
  const D = Math.max(take.duration, 0.1);
  if (!take.trim) take.trim = [0, D];
  const tr = take.trim;
  const sIn = h('input', { type: 'range', min: 0, max: D, step: 0.05, value: tr[0], style: 'flex:1' });
  const sOut = h('input', { type: 'range', min: 0, max: D, step: 0.05, value: tr[1], style: 'flex:1' });
  const lab = h('span', { class: 'muted', style: 'min-width:190px;text-align:right', text: '' });
  const upd = () => { lab.textContent = 'Keep ' + fmt(tr[0]) + ' to ' + fmt(tr[1]) + ' (' + (tr[1] - tr[0]).toFixed(1) + ' s)'; };
  sIn.oninput = () => { tr[0] = Math.min(+sIn.value, tr[1] - 0.1); sIn.value = tr[0]; try { v.currentTime = tr[0]; } catch (_) {} upd(); };
  sOut.oninput = () => { tr[1] = Math.max(+sOut.value, tr[0] + 0.1); sOut.value = tr[1]; try { v.currentTime = tr[1]; } catch (_) {} upd(); };
  // MediaRecorder files lack a duration; nudge the player so seeking works
  v.addEventListener('loadedmetadata', () => { if (!isFinite(v.duration)) { v.currentTime = 1e101; v.addEventListener('timeupdate', function f() { v.removeEventListener('timeupdate', f); v.currentTime = tr[0]; }); } });
  upd();
  const trimRow = h('div', { style: 'display:flex;align-items:center;gap:10px' }, h('span', { class: 'muted', text: 'Trim start' }), sIn, h('span', { class: 'muted', text: 'end' }), sOut, lab,
    btn('Reset', () => { tr[0] = 0; tr[1] = D; sIn.value = 0; sOut.value = D; upd(); }));
  const b = btn('Save', async () => { prog.style.display = ''; ps.style.width = '0%'; b.disabled = true; await save(fm.value); b.disabled = false; prog.style.display = 'none'; }, 'primary');
  toolbar.append(btn('New recording', discard), h('span', { class: 'grow' }), h('span', { class: 'muted', text: 'Format' }), fm, b);
  main.append(h('div', { style: 'flex:1;min-width:0;display:flex;flex-direction:column;padding:12px;gap:10px;overflow:hidden' }, h('div', { style: 'flex:1;min-height:0;display:flex;align-items:center;justify-content:center' }, v), trimRow, prog));
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
    const tr = take.trim || [0, take.duration];
    const trimmed = tr[0] > 0.05 || tr[1] < take.duration - 0.05;
    if (kind === 'webm' && !trimmed) { await window.host.writeFile(dest.id, buf); }
    else {
      const t = await window.host.tempFile(buf, 'webm');
      const cut = trimmed ? ['-ss', tr[0].toFixed(2), '-t', (tr[1] - tr[0]).toFixed(2)] : [];
      const enc = kind === 'webm' ? ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '30', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus'] : ARGS[kind];
      const dur = trimmed ? tr[1] - tr[0] : take.duration;
      try { await window.host.run({ args: ['-i', '{in0}', ...enc, ...(kind === 'gif' && trimmed ? ['-ss', tr[0].toFixed(2), '-t', Math.min(30, tr[1] - tr[0]).toFixed(2)] : cut), '{out}'], inputs: [t.id], out: dest.id, duration: dur }); } finally { window.host.removeFile(t.id); }
    }
    toast('Saved ' + dest.name);
  } catch (e) { toast('Save failed: ' + String(e.message || e).split('\n').pop().slice(0, 90)); }
}

document.addEventListener('keydown', (e) => { if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'r' && rec) { e.preventDefault(); stopRec(); } });
window.addEventListener('beforeunload', (e) => { if (rec || take) { e.preventDefault(); e.returnValue = ''; } });
loadSources();
