// Pencil3D main controller.
import { View } from './view.js';
import { Model, PALETTE, Sessions } from './model.js';
import { OneEuro3, v3, polylineLength, bbox } from './geom.js';
import { buildExportScene, toOBJ, toDXF, toFBX, to3dm, loadRhino, UNITS } from './export/exporters.js';

const P3D = self.P3D, M = P3D.M;
const $ = (id) => document.getElementById(id);
const DEG = Math.PI / 180;

// ------------------------------------------------------------------ settings
const DEFAULTS = {
  paper: 'a4', cubeSize: 3, penLength: 14, tipOffset: null,
  autoFov: true, fov: 65, res: 960, track: 'cube', colorTip: null, planeZ: 0,
  drawMode: 'auto', smooth: 0.5, straighten: false, width: 0.2, color: '#007aff',
  grid: true, mirror: false, snapEnds: true, gridSnap: false, lockCam: false, debug: false,
  export: { formats: { '3dm': true, obj: true, dxf: false, fbx: false }, geometry: 'both', tubes: false, units: 'cm', origin: 'tapped', onlySel: false, name: 'pencil3d' },
};
const settings = (() => {
  try {
    const s = JSON.parse(localStorage.getItem('p3d.settings') || '{}');
    return Object.assign(structuredClone(DEFAULTS), s, { export: Object.assign(structuredClone(DEFAULTS.export), s.export || {}) });
  } catch { return structuredClone(DEFAULTS); }
})();
const saveSettings = () => localStorage.setItem('p3d.settings', JSON.stringify(settings));

// ------------------------------------------------------------------ state
const model = new Model();
const view = new View($('gl'));
const video = $('video');
let board = P3D.boardLayout(settings.paper);
let worker = null, busy = false, frameId = 0, running = false;
const proc = document.createElement('canvas');
const pctx = proc.getContext('2d', { willReadFrequently: true });
let PW = 0, PH = 0, K = null;
let boardPose = null, boardSeen = 0;
let pen = null; // {tip, cube, t, stale}
const euro = new OneEuro3(2.5, 0.08, 1.0);
let lastAccepted = null, jumpCandidate = null;
let drawing = false, current = null, lostSince = 0;
let selected = new Set();
let tool = 'draw'; // draw | select | origin | pick
let calib = null;
const focal = { list: [] };
let fpsCount = 0, fpsT = performance.now(), lastRes = null;

// ------------------------------------------------------------------ layout
function layout() {
  const vw = video.videoWidth || 16, vh = video.videoHeight || 9;
  const s = Math.max(innerWidth / vw, innerHeight / vh);
  const w = Math.round(vw * s), h = Math.round(vh * s);
  const st = $('stage');
  st.style.width = w + 'px'; st.style.height = h + 'px';
  view.resize(w, h);
  const dbg = $('dbg'); dbg.width = w; dbg.height = h;
}
addEventListener('resize', layout);
addEventListener('orientationchange', () => setTimeout(layout, 300));

// ------------------------------------------------------------------ camera + worker
async function startCamera() {
  $('introErr').textContent = '';
  if (!navigator.mediaDevices?.getUserMedia) {
    $('introErr').textContent = 'Camera not available. Open this page over https in Safari.';
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
    });
    video.srcObject = stream;
    await video.play();
  } catch (e) {
    $('introErr').textContent = 'Could not start the camera: ' + (e.message || e.name) + '. Allow camera access in Settings › Safari › Camera.';
    return;
  }
  await new Promise((r) => (video.videoWidth ? r() : video.addEventListener('loadedmetadata', r, { once: true })));
  layout();
  configureProc();
  $('intro').classList.add('hidden');
  if (!worker) {
    worker = new Worker('js/worker.js');
    worker.onmessage = onWorker;
    worker.onerror = (e) => toast('Tracking error: ' + e.message);
  }
  sendConfig();
  running = true;
}

function configureProc() {
  const vw = video.videoWidth, vh = video.videoHeight;
  const s = Math.min(1, settings.res / Math.max(vw, vh));
  PW = Math.round(vw * s); PH = Math.round(vh * s);
  proc.width = PW; proc.height = PH;
}

function focalPx() {
  return (Math.max(PW, PH) / 2) / Math.tan((settings.fov * DEG) / 2);
}
function sendConfig() {
  board = P3D.boardLayout(settings.paper);
  worker?.postMessage({ type: 'config', cfg: { paper: settings.paper, cubeSize: settings.cubeSize, f: PW ? focalPx() : null } });
  rebuildHelpers();
}

function pump() {
  if (!running || busy || video.readyState < 2 || !PW) return;
  busy = true;
  pctx.drawImage(video, 0, 0, PW, PH);
  const im = pctx.getImageData(0, 0, PW, PH);
  worker.postMessage({ type: 'frame', id: ++frameId, w: PW, h: PH, buf: im.data.buffer, mode: settings.track, color: settings.colorTip }, [im.data.buffer]);
}

function onWorker(e) {
  const m = e.data;
  if (m.type !== 'result') return;
  busy = false;
  const res = m.res;
  if (res.error) { console.error(res.error); return; }
  lastRes = res;
  fpsCount++;
  if (!K || K.f !== res.K.f || K.cx !== res.K.cx) { K = res.K; view.setIntrinsics(K, res.W, res.H); }
  const now = performance.now() / 1000;

  // ---- world (desk sheet) pose
  if (res.board) {
    boardSeen = now;
    if (!(settings.lockCam && boardPose)) updateBoardPose(res.board);
    if (settings.autoFov) collectFocal(res);
  }
  if (boardPose) view.setPose(boardPose.R, boardPose.t);

  // ---- pencil tip
  let tip = null, cube = null;
  if (boardPose) {
    if (settings.track === 'cube' && res.pen) {
      const tipLocal = settings.tipOffset || [0, 0, -(settings.cubeSize / 2 + settings.penLength)];
      const tipCam = M.add(M.mulMV(res.pen.R, tipLocal), res.pen.t);
      tip = M.mulMtV(boardPose.R, M.sub(tipCam, boardPose.t));
      cube = M.mulMtV(boardPose.R, M.sub(res.pen.t, boardPose.t));
      if (calib) collectCalib(res.pen);
    } else if (settings.track === 'color' && res.colorTip) {
      const dc = [(res.colorTip.x - K.cx) / K.f, (res.colorTip.y - K.cy) / K.f, 1];
      const o = M.scale(M.mulMtV(boardPose.R, boardPose.t), -1);
      const d = M.mulMtV(boardPose.R, dc);
      tip = View.rayPlaneZ({ o, d }, settings.planeZ);
    }
  }
  if (tip) tip = acceptTip(tip, now);
  if (tip) {
    let p = euro.filter(tip, now);
    if (settings.drawMode === 'surface') p = [p[0], p[1], 0];
    else if (settings.drawMode === 'auto' && p[2] < 0.4) p = [p[0], p[1], 0];
    pen = { tip: p, cube, t: now };
  } else if (pen && now - pen.t > 0.25) {
    pen = null;
    euro.reset();
  }
  onPenSample(now);
  updateStatus(res, now);
  if (settings.debug) drawDebug(res); else clearDebug();
}

function updateBoardPose(b) {
  if (!boardPose) { boardPose = { R: b.R, t: b.t }; return; }
  const dT = M.norm(M.sub(b.t, boardPose.t)), dR = M.rotAngle(b.R, boardPose.R);
  // static phone -> heavy averaging (steady world); moving phone -> follow quickly
  const a = Math.min(1, Math.max(0.08, Math.max(dT / 0.6, dR / (1 * DEG))));
  const t = v3.lerp(boardPose.t, b.t, a);
  const q0 = M.quatFromRot(boardPose.R); let q1 = M.quatFromRot(b.R);
  if (q0[0] * q1[0] + q0[1] * q1[1] + q0[2] * q1[2] + q0[3] * q1[3] < 0) q1 = q1.map((x) => -x);
  const q = q0.map((x, i) => x + (q1[i] - x) * a);
  const n = Math.hypot(...q);
  boardPose = { R: M.rotFromQuat(q.map((x) => x / n)), t };
}

/** reject single-frame jumps (mis-detections) */
function acceptTip(tip, now) {
  if (lastAccepted && now - lastAccepted.t < 0.3 && v3.dist(tip, lastAccepted.p) > 3) {
    if (jumpCandidate && v3.dist(tip, jumpCandidate) < 1) { jumpCandidate = null; }
    else { jumpCandidate = tip; return null; }
  }
  lastAccepted = { p: tip, t: now };
  return tip;
}

function collectFocal(res) {
  const R = res.board.R;
  const tilt = Math.acos(Math.min(1, Math.abs(R[8])));
  if (tilt < 20 * DEG || res.board.n < 4) return;
  let sab = 0, sbb = 0;
  for (const { a, b } of res.board.focal) { sab += a * b; sbb += b * b; }
  const f2 = -sab / sbb;
  if (!(f2 > 0)) return;
  const fNorm = Math.sqrt(f2) / Math.max(res.W, res.H);
  const fov = (2 * Math.atan(0.5 / fNorm)) / DEG;
  if (fov < 40 || fov > 100) return;
  focal.list.push(fov);
  if (focal.list.length > 120) focal.list.shift();
  if (focal.list.length >= 20 && focal.list.length % 10 === 0) {
    const s = focal.list.slice().sort((x, y) => x - y);
    const med = s[s.length >> 1];
    if (Math.abs(med - settings.fov) > 0.15) {
      settings.fov = +med.toFixed(2); saveSettings(); sendConfig(); renderSetup();
    }
  }
}

// ------------------------------------------------------------------ drawing
function onPenSample(now) {
  if (!drawing) return;
  if (pen && now - pen.t < 0.05) {
    if (!current) current = { raw: [] };
    const last = current.raw[current.raw.length - 1];
    if (!last || v3.dist(last, pen.tip) > 0.03) current.raw.push(pen.tip.slice());
    lostSince = 0;
  } else if (current && current.raw.length) {
    if (!lostSince) lostSince = now;
    if (now - lostSince > 0.3) { finishStroke(); current = null; } // tracking lost: split stroke
  }
  view.setLive(current?.raw, settings.color, settings.width);
  $('bDraw').classList.toggle('wait', !pen);
}

function startDraw(e) {
  e.preventDefault();
  if (tool !== 'draw') setTool('draw');
  drawing = true; current = null; lostSince = 0;
  $('bDraw').classList.add('active');
  try { $('bDraw').setPointerCapture(e.pointerId); } catch {}
}
function endDraw() {
  if (!drawing) return;
  drawing = false;
  $('bDraw').classList.remove('active', 'wait');
  finishStroke();
  current = null;
  view.setLive(null);
}

function finishStroke() {
  if (!current || current.raw.length < 2 || polylineLength(current.raw) < 0.2) return;
  let raw = current.raw;
  model.commit(() => {
    raw = snapEnds(raw);
    const props = { raw, color: settings.color, width: settings.width, smooth: settings.smooth, straight: settings.straighten };
    model.addStroke(props);
    if (settings.mirror) {
      const ox = model.origin ? model.origin[0] : 0;
      model.addStroke(Object.assign({}, props, { raw: raw.map((p) => [2 * ox - p[0], p[1], p[2]]) }));
    }
  });
}

function snapEnds(raw) {
  raw = raw.map((p) => p.slice());
  const targets = [];
  if (settings.snapEnds) for (const s of model.visibleStrokes()) { const p = model.pts(s); targets.push(p[0], p[p.length - 1]); }
  const fix = (idx, dirn) => {
    const e = raw[idx];
    let tgt = null, bd = 0.6;
    for (const t of targets) { const d = v3.dist(t, e); if (d < bd) { bd = d; tgt = t; } }
    if (!tgt && idx === raw.length - 1 && settings.snapEnds && v3.dist(raw[0], e) < 0.6) tgt = raw[0]; // close loop
    if (!tgt && settings.gridSnap) tgt = e.map((x) => Math.round(x * 2) / 2);
    if (!tgt) return;
    const delta = v3.sub(tgt, e);
    // blend the correction over ~1.5 cm of the stroke
    let acc = 0;
    for (let k = 0; k < raw.length; k++) {
      const i = dirn > 0 ? k : raw.length - 1 - k;
      if (k) acc += v3.dist(raw[i], raw[i - dirn]);
      const w = Math.max(0, 1 - acc / 1.5);
      if (!w) break;
      raw[i] = v3.add(raw[i], v3.scale(delta, w));
    }
  };
  fix(0, 1);
  targets.push(raw[0]);
  fix(raw.length - 1, -1);
  return raw;
}

// ------------------------------------------------------------------ stage interaction
let drag = null;
const stage = $('gl');
stage.addEventListener('pointerdown', (e) => {
  const r = stage.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  drag = { x0: x, y0: y, x, y, moved: false, r, id: e.pointerId, applied: [0, 0, 0] };
  stage.setPointerCapture(e.pointerId);
});
stage.addEventListener('pointermove', (e) => {
  if (!drag) return;
  drag.x = e.clientX - drag.r.left; drag.y = e.clientY - drag.r.top;
  if (!drag.moved && Math.hypot(drag.x - drag.x0, drag.y - drag.y0) > 8) {
    drag.moved = true;
    if (tool === 'select' && selected.size && view.pose) {
      model.beginEdit();
      const st = model.stats([...selected]);
      drag.center = st.bbox ? v3.lerp(st.bbox.min, st.bbox.max, 0.5) : [0, 0, 0];
      drag.start = View.rayPlaneZ(view.ray(drag.x0, drag.y0, drag.r.width, drag.r.height), drag.center[2]);
    }
  }
  if (drag.moved && drag.center) {
    let d;
    if (moveAxis === 'z') {
      const q = view.toImage(drag.center, drag.r.width, drag.r.height);
      const fCss = (K.f * drag.r.width) / view.W;
      d = [0, 0, (-(drag.y - drag.y0) * (q ? q[2] : 40)) / fCss];
    } else {
      const p = View.rayPlaneZ(view.ray(drag.x, drag.y, drag.r.width, drag.r.height), drag.center[2]);
      if (!p || !drag.start) return;
      d = v3.sub(p, drag.start); d[2] = 0;
    }
    model.translate([...selected], v3.sub(d, drag.applied));
    drag.applied = d;
    model.changed();
  }
});
stage.addEventListener('pointerup', (e) => {
  if (!drag) return;
  const d = drag; drag = null;
  if (d.moved) return;
  const W = d.r.width, H = d.r.height;
  if (tool === 'select') {
    const hit = view.pick(model, d.x, d.y, W, H);
    if (hit) { selected.has(hit.id) ? selected.delete(hit.id) : selected.add(hit.id); }
    else selected.clear();
    refreshSelection();
  } else if (tool === 'origin') {
    const hit = view.pick(model, d.x, d.y, W, H);
    const p = hit ? hit.point : View.rayPlaneZ(view.ray(d.x, d.y, W, H), 0);
    if (p) {
      model.commit(() => { model.origin = p.map((x) => +x.toFixed(4)); });
      toast(`Origin set at ${fmtP(p)} cm`);
      settings.export.origin = 'tapped'; saveSettings(); renderExport();
    }
    setTool('draw');
  } else if (tool === 'pick') {
    const c = document.createElement('canvas'); c.width = c.height = 9;
    const g = c.getContext('2d');
    const u = (d.x / W) * video.videoWidth, v = (d.y / H) * video.videoHeight;
    g.drawImage(video, u - 4, v - 4, 9, 9, 0, 0, 9, 9);
    const px = g.getImageData(0, 0, 9, 9).data;
    let r = 0, gg = 0, b = 0;
    for (let i = 0; i < px.length; i += 4) { r += px[i]; gg += px[i + 1]; b += px[i + 2]; }
    const n = px.length / 4;
    settings.colorTip = { r: r / n, g: gg / n, b: b / n };
    saveSettings(); renderSetup();
    toast('Tip colour picked');
    setTool('draw');
  }
});
stage.addEventListener('pointercancel', () => { drag = null; });

let moveAxis = 'xy';
function setTool(t) {
  tool = t;
  $('bSelect').classList.toggle('on', t === 'select');
  const banner = { select: 'Tap strokes to select · drag to move', origin: 'Tap a stroke or the desk to set the origin', pick: 'Tap the coloured pencil tip' }[t];
  $('modeBanner').textContent = banner || '';
  $('modeBanner').classList.toggle('hidden', !banner);
  if (t !== 'select') { selected.clear(); }
  refreshSelection();
}
function refreshSelection() {
  for (const id of [...selected]) if (!model.strokes.some((s) => s.id === id)) selected.delete(id);
  $('selBar').classList.toggle('hidden', !(tool === 'select' && selected.size));
  view.syncStrokes(model, selected);
  updateInfo();
}

$('selBar').addEventListener('click', (e) => {
  const act = e.target.dataset.act;
  if (!act) return;
  const ids = [...selected];
  if (act === 'del') { model.commit(() => model.deleteStrokes(ids)); selected.clear(); }
  if (act === 'dup') { let n; model.commit(() => { n = model.duplicate(ids); }); selected = new Set(n); }
  if (act === 'axis') { moveAxis = moveAxis === 'xy' ? 'z' : 'xy'; $('bAxis').textContent = moveAxis === 'xy' ? 'Move: XY' : 'Move: Z (up/down)'; }
  if (act === 'style') model.commit(() => { for (const s of model.byIds(ids)) Object.assign(s, { color: settings.color, width: settings.width, smooth: settings.smooth, straight: settings.straighten }); });
  if (act === 'layer') model.commit(() => { for (const s of model.byIds(ids)) s.layer = model.activeLayer; });
  if (act === 'none') { setTool('draw'); return; }
  refreshSelection();
});

// ------------------------------------------------------------------ status / HUD
function updateStatus(res, now) {
  const bAge = now - boardSeen;
  setPill('pillBoard', res.board ? 'ok' : boardPose && (settings.lockCam || bAge < 2) ? 'warn' : 'bad',
    res.board ? `Sheet ${res.board.n}` : settings.lockCam && boardPose ? 'Sheet (locked)' : 'Sheet');
  const penOk = settings.track === 'cube' ? !!res.pen : !!res.colorTip;
  setPill('pillPen', penOk && boardPose ? 'ok' : 'bad', settings.track === 'cube' ? (res.pen ? `Pencil ${res.pen.faces}` : 'Pencil') : 'Tip colour');
  if (performance.now() - fpsT > 1000) {
    $('pillFps').textContent = `${fpsCount} fps · ${res.ms.toFixed(0)} ms`;
    fpsCount = 0; fpsT = performance.now();
  }
  const o = model.origin || [0, 0, 0];
  $('hudTip').textContent = pen
    ? `Tip X ${fmt(pen.tip[0] - o[0])}  Y ${fmt(pen.tip[1] - o[1])}  Z ${fmt(pen.tip[2] - o[2])} cm` + (model.origin ? ' (from origin)' : '')
    : 'Tip —';
  if (drawing && current) $('hudInfo').textContent = `Stroke ${polylineLength(current.raw).toFixed(1)} cm`;
}
function updateInfo() {
  if (selected.size) {
    const s = model.stats([...selected]);
    const d = s.bbox ? v3.sub(s.bbox.max, s.bbox.min) : [0, 0, 0];
    $('hudInfo').textContent = `${s.count} selected · length ${s.length.toFixed(1)} cm · box ${d.map((x) => x.toFixed(1)).join(' × ')} cm`;
  } else {
    const n = model.strokes.length;
    $('hudInfo').textContent = n ? `${n} stroke${n > 1 ? 's' : ''}` : '';
  }
}
function setPill(id, cls, text) { const el = $(id); el.className = 'pill ' + cls; el.textContent = text; }
const fmt = (x) => (x >= 0 ? ' ' : '') + x.toFixed(1);
const fmtP = (p) => p.map((x) => x.toFixed(1)).join(', ');
let toastT;
function toast(msg, ms = 2200) {
  const t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.add('hidden'), ms);
}

function drawDebug(res) {
  const c = $('dbg'), g = c.getContext('2d');
  g.clearRect(0, 0, c.width, c.height);
  const sx = c.width / res.W, sy = c.height / res.H;
  g.lineWidth = 2; g.font = '12px -apple-system, sans-serif';
  for (const m of res.markers) {
    g.strokeStyle = m.id >= P3D.CUBE_ID_BASE ? '#ffd60a' : '#30d158';
    g.beginPath();
    m.c.forEach((p, i) => (i ? g.lineTo((p[0] + 0.5) * sx, (p[1] + 0.5) * sy) : g.moveTo((p[0] + 0.5) * sx, (p[1] + 0.5) * sy)));
    g.closePath(); g.stroke();
    g.fillStyle = '#fff'; g.fillText(m.id, (m.c[0][0] + 0.5) * sx + 3, (m.c[0][1] + 0.5) * sy + 13);
  }
  if (res.colorTip) { g.strokeStyle = '#ff2d55'; g.beginPath(); g.arc((res.colorTip.x + 0.5) * sx, (res.colorTip.y + 0.5) * sy, 12, 0, 7); g.stroke(); }
}
function clearDebug() { const c = $('dbg'); if (c._dirty !== false) { c.getContext('2d').clearRect(0, 0, c.width, c.height); c._dirty = false; } }

// ------------------------------------------------------------------ render loop
function frame() {
  requestAnimationFrame(frame);
  pump();
  const now = performance.now() / 1000;
  view.setCursor(pen ? pen.tip : null, pen ? pen.cube : null, { width: settings.width, color: settings.color, drawing, stale: pen && now - pen.t > 0.15 });
  view.render();
}
requestAnimationFrame(frame);

// ------------------------------------------------------------------ calibration
function startCalib() {
  if (!running) { toast('Start the camera first'); return; }
  calib = { poses: [], result: null };
  $('calibBar').style.width = '0%';
  $('calibMsg').textContent = 'Waiting for the pencil cube…';
  $('calibUse').disabled = true;
  $('calib').classList.remove('hidden');
  closeSheet();
}
function collectCalib(penPose) {
  if (!boardPose) return;
  const R = M.mulMM(M.transpose(boardPose.R), penPose.R);
  const t = M.mulMtV(boardPose.R, M.sub(penPose.t, boardPose.t));
  calib.poses.push({ R, t });
  if (calib.poses.length > 400) calib.poses.shift();
  const n = calib.poses.length;
  let spread = 0;
  if (n % 5 === 0 && n >= 15) {
    const r = M.pivotCalibration(calib.poses);
    spread = r ? r.spreadDeg : 0;
    const progress = Math.min(1, n / 150) * Math.min(1, spread / 35);
    $('calibBar').style.width = (progress * 100).toFixed(0) + '%';
    if (r && progress >= 1) {
      calib.result = r;
      const len = M.norm(r.tip);
      const expected = settings.cubeSize / 2 + settings.penLength;
      $('calibMsg').innerHTML = `Tip found ${len.toFixed(1)} cm from the cube centre (setting says ${expected.toFixed(1)}).<br>` +
        `Consistency ±${(r.rms * 10).toFixed(1)} mm ${r.rms < 0.25 ? '✓ good' : r.rms < 0.5 ? '– ok' : '– poor, try again slower'}`;
      $('calibUse').disabled = false;
    } else {
      $('calibMsg').textContent = spread < 20 ? 'Tilt the pencil more, in a circle around the tip…' : 'Keep going…';
    }
  }
}
$('calibCancel').onclick = () => { calib = null; $('calib').classList.add('hidden'); };
$('calibUse').onclick = () => {
  if (calib?.result) {
    settings.tipOffset = calib.result.tip;
    saveSettings(); renderSetup();
    toast(`Tip calibrated · ±${(calib.result.rms * 10).toFixed(1)} mm`);
  }
  calib = null; $('calib').classList.add('hidden');
};

// ------------------------------------------------------------------ UI: sheet + panels
function openSheet(tab) { $('sheet').classList.remove('hidden'); if (tab) showTab(tab); }
function closeSheet() { $('sheet').classList.add('hidden'); }
function showTab(name) {
  document.querySelectorAll('.tabs [data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  document.querySelectorAll('#sheet section').forEach((s) => (s.hidden = s.dataset.panel !== name));
  if (name === 'export') { renderExport(); if (settings.export.formats['3dm']) loadRhino().catch(() => {}); }
  if (name === 'files') renderSessions();
  if (name === 'layers') renderLayers();
}
document.querySelector('.tabs').addEventListener('click', (e) => { const t = e.target.dataset.tab; if (t) showTab(t); });
$('bClose').onclick = closeSheet;
$('bMenu').onclick = () => ($('sheet').classList.contains('hidden') ? openSheet() : closeSheet());
$('bSelect').onclick = () => setTool(tool === 'select' ? 'draw' : 'select');
$('bUndo').onclick = () => { if (!model.undo()) toast('Nothing to undo'); };
$('bRedo').onclick = () => { if (!model.redo()) toast('Nothing to redo'); };
$('bDraw').addEventListener('pointerdown', startDraw);
$('bDraw').addEventListener('pointerup', endDraw);
$('bDraw').addEventListener('pointercancel', endDraw);
$('bDraw').addEventListener('lostpointercapture', endDraw);
$('bDraw').addEventListener('contextmenu', (e) => e.preventDefault());

function seg(id, get, set) {
  const el = $(id);
  const paint = () => el.querySelectorAll('button').forEach((b) => b.classList.toggle('on', String(get()) === b.dataset.v));
  el.addEventListener('click', (e) => { const v = e.target.dataset.v; if (v === undefined) return; set(v); saveSettings(); paint(); });
  paint();
  return paint;
}
function check(id, get, set) {
  const el = $(id); el.checked = !!get();
  el.addEventListener('change', () => { set(el.checked); saveSettings(); });
  return () => (el.checked = !!get());
}
function range(id, out, get, set, fmtv) {
  const el = $(id), o = $(out);
  const paint = () => { el.value = get(); if (o) o.textContent = fmtv(get()); };
  el.addEventListener('input', () => { set(parseFloat(el.value)); if (o) o.textContent = fmtv(get()); });
  el.addEventListener('change', saveSettings);
  paint();
  return paint;
}

// pen panel
function renderSwatches() {
  const w = $('swatches'); w.innerHTML = '';
  for (const c of PALETTE) {
    const b = document.createElement('button');
    b.style.background = c; b.classList.toggle('on', c === settings.color); b.setAttribute('aria-label', c);
    b.onclick = () => { settings.color = c; saveSettings(); renderSwatches(); };
    w.appendChild(b);
  }
  const ci = document.createElement('input'); ci.type = 'color'; ci.value = settings.color;
  ci.oninput = () => { settings.color = ci.value; saveSettings(); };
  w.appendChild(ci);
}
renderSwatches();
range('iWidth', 'oWidth', () => settings.width, (v) => (settings.width = v), (v) => `${(v * 10).toFixed(1)} mm`);
range('iSmooth', 'oSmooth', () => settings.smooth, (v) => (settings.smooth = v), (v) => (v === 0 ? 'off' : `${Math.round(v * 100)}%`));
seg('segDraw', () => settings.drawMode, (v) => (settings.drawMode = v));
check('cStraight', () => settings.straighten, (v) => (settings.straighten = v));

// tools panel
check('cGrid', () => settings.grid, (v) => { settings.grid = v; rebuildHelpers(); });
check('cMirror', () => settings.mirror, (v) => { settings.mirror = v; rebuildHelpers(); });
check('cSnapEnds', () => settings.snapEnds, (v) => (settings.snapEnds = v));
check('cGridSnap', () => settings.gridSnap, (v) => (settings.gridSnap = v));
check('cLock', () => settings.lockCam, (v) => (settings.lockCam = v));
$('bOrigin').onclick = () => { closeSheet(); setTool('origin'); };
$('bOriginClear').onclick = () => { model.commit(() => { model.origin = null; }); toast('Origin cleared'); };
$('bClear').onclick = () => { if (model.strokes.length && confirm('Delete all strokes? (You can undo.)')) model.commit(() => { model.strokes = []; }); };
function rebuildHelpers() { view.buildHelpers(board, { grid: settings.grid, mirror: settings.mirror, origin: model.origin }); }

// layers panel
function renderLayers() {
  const list = $('layerList'); list.innerHTML = '';
  for (const L of model.layers) {
    const row = document.createElement('div');
    row.className = 'layer' + (L.id === model.activeLayer ? ' active' : '');
    const n = model.strokes.filter((s) => s.layer === L.id).length;
    row.innerHTML = `<input type="color" value="${L.color}"><span class="name"></span><button data-a="vis">${L.visible !== false ? 'Hide' : 'Show'}</button><button data-a="ren">Rename</button><button data-a="del">✕</button>`;
    row.querySelector('.name').textContent = `${L.name} (${n})`;
    row.querySelector('input').onchange = (e) => model.commit(() => { L.color = e.target.value; });
    row.onclick = (e) => {
      const a = e.target.dataset.a;
      if (e.target.tagName === 'INPUT') return;
      if (a === 'vis') model.commit(() => { L.visible = L.visible === false; });
      else if (a === 'ren') { const nn = prompt('Layer name', L.name); if (nn) model.commit(() => { L.name = nn.trim().slice(0, 60); }); }
      else if (a === 'del') { if (model.layers.length > 1 && confirm(`Delete layer "${L.name}" and its ${n} strokes?`)) model.commit(() => model.deleteLayer(L.id)); }
      else model.commit(() => { model.activeLayer = L.id; });
      renderLayers();
    };
    list.appendChild(row);
  }
}
$('bAddLayer').onclick = () => { model.commit(() => model.addLayer()); renderLayers(); };

// export panel
const ex = settings.export;
document.querySelectorAll('[data-fmt]').forEach((el) => {
  el.checked = !!ex.formats[el.dataset.fmt];
  el.onchange = () => { ex.formats[el.dataset.fmt] = el.checked; saveSettings(); if (el.checked && el.dataset.fmt === '3dm') loadRhino().catch(() => {}); };
});
const paintGeom = seg('segGeom', () => ex.geometry, (v) => (ex.geometry = v));
const paintUnits = seg('segUnits', () => ex.units, (v) => (ex.units = v));
const paintOrigin = seg('segOrigin', () => ex.origin, (v) => { ex.origin = v; renderExport(); });
check('cTubes', () => ex.tubes, (v) => (ex.tubes = v));
check('cOnlySel', () => ex.onlySel, (v) => (ex.onlySel = v));
$('iName').value = ex.name;
$('iName').onchange = () => { ex.name = $('iName').value.trim() || 'pencil3d'; saveSettings(); };
function renderExport() {
  paintGeom(); paintUnits(); paintOrigin();
  $('originHint').textContent = ex.origin === 'tapped'
    ? (model.origin ? `Origin at ${fmtP(model.origin)} cm (sheet coordinates).` : 'No origin tapped yet — the bounding-box corner will be used. Set one in Tools.')
    : ex.origin === 'bbox' ? 'Lowest X, Y, Z corner of all exported lines becomes 0,0,0.' : 'Centre of the printed sheet is 0,0,0.';
}

$('bExport').onclick = async () => {
  const out = $('exportOut'); out.innerHTML = '';
  const fm = ex.formats;
  if (!fm['3dm'] && !fm.obj && !fm.dxf && !fm.fbx) { toast('Choose at least one format'); return; }
  const ids = ex.onlySel && selected.size ? [...selected] : null;
  if (!model.visibleStrokes().length) { toast('Nothing to export yet'); return; }
  let rh = null;
  if (fm['3dm']) {
    try { rh = await loadRhino(); } catch (e) { out.textContent = 'Could not load the Rhino library: ' + e.message; return; }
  }
  const S = buildExportScene(model, (s) => model.pts(s), { units: ex.units, origin: ex.origin, geometry: ex.geometry, tubes: ex.tubes, onlyIds: ids });
  const name = (ex.name || 'pencil3d').replace(/[^\w\-]+/g, '_');
  const files = [];
  try {
    if (fm['3dm']) files.push(new File([to3dm(rh, S)], `${name}.3dm`, { type: 'application/octet-stream' }));
    if (fm.obj) { const o = toOBJ(S, name); files.push(new File([o.obj], `${name}.obj`, { type: 'text/plain' }), new File([o.mtl], `${name}.mtl`, { type: 'text/plain' })); }
    if (fm.dxf) files.push(new File([toDXF(S)], `${name}.dxf`, { type: 'application/dxf' }));
    if (fm.fbx) files.push(new File([toFBX(S)], `${name}.fbx`, { type: 'application/octet-stream' }));
  } catch (e) { out.textContent = 'Export failed: ' + e.message; console.error(e); return; }
  const info = document.createElement('div');
  info.className = 'hint';
  info.textContent = `${S.items.length} stroke(s), units ${UNITS[ex.units].label.toLowerCase()}, Z up.`;
  out.appendChild(info);
  const share = async () => {
    try { await navigator.share({ files, title: name }); return true; }
    catch (e) { if (e.name === 'AbortError') return true; return false; }
  };
  const canShare = navigator.canShare && navigator.canShare({ files });
  if (canShare && (await share())) return;
  if (canShare) {
    const b = document.createElement('button'); b.className = 'primary'; b.textContent = 'Share files';
    b.onclick = share; out.appendChild(b);
  }
  for (const f of files) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(f); a.download = f.name; a.textContent = `Download ${f.name} (${(f.size / 1024).toFixed(0)} kB)`;
    out.appendChild(a);
  }
};

// files panel
async function renderSessions() {
  const list = $('sessionList'); list.innerHTML = '';
  let items = [];
  try { items = await Sessions.list(); } catch (e) { list.textContent = 'Storage unavailable.'; return; }
  if (!items.length) { list.innerHTML = '<p class="hint">No saved drawings yet.</p>'; return; }
  for (const it of items) {
    const row = document.createElement('div'); row.className = 'session';
    const n = JSON.parse(it.data).strokes?.length || 0;
    row.innerHTML = `<div class="name"></div><button data-a="open">Open</button><button data-a="del">✕</button>`;
    row.querySelector('.name').innerHTML = `<span></span><small>${new Date(it.date).toLocaleString()} · ${n} strokes</small>`;
    row.querySelector('.name span').textContent = it.name;
    row.onclick = async (e) => {
      const a = e.target.dataset.a;
      if (a === 'open') { model.commit(() => model.apply(it.data)); selected.clear(); $('iSession').value = it.name; toast(`Opened "${it.name}"`); }
      if (a === 'del' && confirm(`Delete "${it.name}"?`)) { await Sessions.remove(it.id); renderSessions(); }
    };
    list.appendChild(row);
  }
}
$('bSave').onclick = async () => {
  const name = $('iSession').value.trim() || `Drawing ${new Date().toLocaleString()}`;
  $('iSession').value = name;
  try { await Sessions.save(name, model.serialize()); toast(`Saved "${name}"`); renderSessions(); }
  catch (e) { toast('Could not save: ' + e.message); }
};
$('bNew').onclick = () => {
  if (model.strokes.length && !confirm('Start a new drawing? The current one stays in Undo; save it first if you want to keep it.')) return;
  model.commit(() => model.blank()); selected.clear(); $('iSession').value = '';
};

// setup panel
const paintTrack = seg('segTrack', () => settings.track, (v) => { settings.track = v; renderSetup(); euro.reset(); pen = null; });
const paintPaper = seg('segPaper', () => settings.paper, (v) => { settings.paper = v; sendConfig(); });
const paintRes = seg('segRes', () => settings.res, (v) => { settings.res = +v; if (running) { configureProc(); sendConfig(); } });
const paintCube = range('iCube', 'oCube', () => settings.cubeSize, (v) => { settings.cubeSize = v; settings.tipOffset = null; sendConfig(); renderSetup(); }, (v) => `${v.toFixed(1)} cm`);
const paintPen = range('iPen', 'oPen', () => settings.penLength, (v) => { settings.penLength = v; renderSetup(); }, (v) => `${v.toFixed(1)} cm`);
const paintPlane = range('iPlane', 'oPlane', () => settings.planeZ, (v) => (settings.planeZ = v), (v) => `${v.toFixed(1)} cm`);
const paintFov = range('iFov', 'oFov', () => settings.fov, (v) => { settings.fov = v; settings.autoFov = false; $('cAutoFov').checked = false; focal.list = []; sendConfig(); }, (v) => `${v.toFixed(1)}°`);
check('cAutoFov', () => settings.autoFov, (v) => { settings.autoFov = v; focal.list = []; });
check('cDebug', () => settings.debug, (v) => { settings.debug = v; $('dbg')._dirty = true; });
$('bCalib').onclick = startCalib;
$('bCalibReset').onclick = () => { settings.tipOffset = null; saveSettings(); renderSetup(); toast('Using the pencil length setting'); };
$('bPick').onclick = () => { closeSheet(); setTool('pick'); };
function renderSetup() {
  paintTrack(); paintPaper(); paintRes(); paintCube(); paintPen(); paintPlane(); paintFov();
  $('cubeSetup').hidden = settings.track !== 'cube';
  $('colorSetup').hidden = settings.track !== 'color';
  $('tipHint').textContent = settings.tipOffset
    ? `Calibrated tip: ${M.norm(settings.tipOffset).toFixed(1)} cm from the cube centre.`
    : 'Not calibrated: using the pencil length. Calibrate for best accuracy.';
  const c = settings.colorTip;
  $('pickedColor').innerHTML = c ? `Tip colour: <span style="display:inline-block;width:14px;height:14px;border-radius:50%;vertical-align:middle;background:rgb(${c.r | 0},${c.g | 0},${c.b | 0})"></span>` : 'No tip colour picked yet.';
}
renderSetup();

$('bHelp').onclick = () => { closeSheet(); $('bStart').textContent = running ? 'Close' : 'Start camera'; $('intro').classList.remove('hidden'); };
$('bStart').onclick = () => (running ? $('intro').classList.add('hidden') : startCamera());

model.addEventListener('change', () => { refreshSelection(); rebuildHelpers(); if (!$('sheet').classList.contains('hidden')) { renderLayers(); renderExport(); } });
refreshSelection();
rebuildHelpers();

// offline support
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// debugging hook for automated tests
self.__p3d = { model, settings, view, get pen() { return pen; }, get boardPose() { return boardPose; }, get lastRes() { return lastRes; }, startDraw: () => startDraw({ preventDefault() {}, pointerId: 0 }), endDraw };
