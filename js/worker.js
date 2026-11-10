/* Tracking worker: receives RGBA frames, returns board/pen poses. Runs fully on-device. */
importScripts(
  '../vendor/cv.js', '../vendor/aruco.js', '../vendor/aruco_mip_16h3.js',
  'core/markers.js', 'core/cvmath.js', 'core/tracker.js'
);

let tracker = null;
let lastColor = null;

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'config') {
    if (!tracker) tracker = new self.P3D.Tracker(m.cfg);
    else tracker.configure(m.cfg);
    return;
  }
  if (m.type === 'frame') {
    const img = { width: m.w, height: m.h, data: new Uint8ClampedArray(m.buf) };
    let res;
    try {
      res = m.mode === 'color' ? colorOnly(img) : tracker.process(img);
      if (m.mode === 'color' && m.color) res.colorTip = findColor(img, m.color);
    } catch (err) {
      res = { error: String(err && err.stack || err) };
    }
    self.postMessage({ type: 'result', id: m.id, res, buf: m.buf }, [m.buf]);
  }
};

function colorOnly(img) {
  // the sheet is still needed for the world frame
  const r = tracker.process(img);
  r.pen = null;
  return r;
}

/** Track a coloured blob (plain-pencil test mode). color: {r,g,b,tol} */
function findColor(img, color) {
  const { width: W, height: H, data } = img;
  const tr = color.r, tg = color.g, tb = color.b;
  const ts = tr + tg + tb + 1;
  const cr = tr / ts, cg = tg / ts;
  const tol = color.tol || 0.06;
  const step = 2;
  let x0 = 0, y0 = 0, x1 = W, y1 = H;
  if (lastColor) {
    const R = 140;
    x0 = Math.max(0, lastColor.x - R); x1 = Math.min(W, lastColor.x + R);
    y0 = Math.max(0, lastColor.y - R); y1 = Math.min(H, lastColor.y + R);
  }
  let sx = 0, sy = 0, n = 0;
  for (let y = y0 | 0; y < y1; y += step) {
    for (let x = x0 | 0; x < x1; x += step) {
      const i = (y * W + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const s = r + g + b + 1;
      if (s < 60) continue;
      const dr = r / s - cr, dg = g / s - cg;
      const bright = s / ts;
      if (dr * dr + dg * dg < tol * tol && bright > 0.45 && bright < 2.2) { sx += x; sy += y; n++; }
    }
  }
  if (n < 6) {
    if (lastColor) { lastColor = null; return findColor(img, color); }
    return null;
  }
  lastColor = { x: sx / n, y: sy / n };
  return { x: sx / n, y: sy / n, n };
}
