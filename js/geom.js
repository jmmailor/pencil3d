// Geometry helpers: filtering, stroke smoothing, NURBS fitting, tube meshes. Units: cm.

export const v3 = {
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  dist: (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]),
  norm: (a) => { const n = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / n, a[1] / n, a[2] / n]; },
  lerp: (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
};

/** One-Euro filter for 3D points (Casiez et al.). */
export class OneEuro3 {
  constructor(minCutoff = 1.5, beta = 0.05, dCutoff = 1.0) {
    Object.assign(this, { minCutoff, beta, dCutoff });
    this.reset();
  }
  reset() { this.x = null; this.dx = [0, 0, 0]; this.t = 0; }
  static alpha(cutoff, dt) { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); }
  filter(p, tSec) {
    if (!this.x) { this.x = p.slice(); this.t = tSec; return p.slice(); }
    const dt = Math.max(1e-3, tSec - this.t);
    this.t = tSec;
    const d = v3.scale(v3.sub(p, this.x), 1 / dt);
    const ad = OneEuro3.alpha(this.dCutoff, dt);
    this.dx = v3.lerp(this.dx, d, ad);
    const cutoff = this.minCutoff + this.beta * v3.len(this.dx);
    this.x = v3.lerp(this.x, p, OneEuro3.alpha(cutoff, dt));
    return this.x.slice();
  }
}

export function polylineLength(pts) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += v3.dist(pts[i - 1], pts[i]);
  return L;
}

/** Resample a polyline at (approximately) uniform arc-length spacing. */
export function resample(pts, spacing) {
  if (pts.length < 2) return pts.map((p) => p.slice());
  const L = polylineLength(pts);
  const n = Math.max(2, Math.round(L / spacing) + 1);
  const step = L / (n - 1);
  const out = [pts[0].slice()];
  let seg = 1, acc = 0, segLen = v3.dist(pts[0], pts[1]);
  for (let k = 1; k < n - 1; k++) {
    const target = k * step;
    while (acc + segLen < target && seg < pts.length - 1) { acc += segLen; seg++; segLen = v3.dist(pts[seg - 1], pts[seg]); }
    const t = segLen > 0 ? (target - acc) / segLen : 0;
    out.push(v3.lerp(pts[seg - 1], pts[seg], Math.min(1, Math.max(0, t))));
  }
  out.push(pts[pts.length - 1].slice());
  return out;
}

/** Gaussian smoothing along arc length; endpoints stay fixed. sigma in cm. */
export function gaussianSmooth(pts, sigma, spacing) {
  if (sigma <= 0 || pts.length < 3) return pts.map((p) => p.slice());
  const r = Math.max(1, Math.round((2.5 * sigma) / spacing));
  const w = [];
  for (let k = -r; k <= r; k++) w.push(Math.exp(-0.5 * ((k * spacing) / sigma) ** 2));
  const n = pts.length, out = [pts[0].slice()];
  for (let i = 1; i < n - 1; i++) {
    // shrink the window near the ends so the ends don't get pulled inwards
    const rr = Math.min(r, i, n - 1 - i);
    let s = [0, 0, 0], ws = 0;
    for (let k = -rr; k <= rr; k++) {
      const wk = w[k + r];
      const p = pts[i + k];
      s[0] += p[0] * wk; s[1] += p[1] * wk; s[2] += p[2] * wk; ws += wk;
    }
    out.push([s[0] / ws, s[1] / ws, s[2] / ws]);
  }
  out.push(pts[n - 1].slice());
  return out;
}

/** Ramer–Douglas–Peucker simplification in 3D. */
export function simplify(pts, tol) {
  if (pts.length < 3) return pts.map((p) => p.slice());
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const A = pts[a], B = pts[b], AB = v3.sub(B, A), L2 = v3.dot(AB, AB);
    let md = -1, mi = -1;
    for (let i = a + 1; i < b; i++) {
      const AP = v3.sub(pts[i], A);
      const t = L2 > 0 ? Math.max(0, Math.min(1, v3.dot(AP, AB) / L2)) : 0;
      const d = v3.dist(pts[i], v3.add(A, v3.scale(AB, t)));
      if (d > md) { md = d; mi = i; }
    }
    if (md > tol) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
  }
  return pts.filter((_, i) => keep[i]).map((p) => p.slice());
}

/** Max distance of points from the chord, relative to length. */
export function straightness(pts) {
  const A = pts[0], B = pts[pts.length - 1], AB = v3.sub(B, A), L = v3.len(AB);
  if (L < 1e-6) return Infinity;
  let md = 0;
  for (const p of pts) md = Math.max(md, v3.len(v3.cross(v3.sub(p, A), AB)) / L);
  return md / L;
}

/**
 * Turn raw tracked points into the clean display/export polyline.
 * smooth: 0..1 ; straighten: auto-convert near-straight strokes to a line.
 */
export function processStroke(raw, { smooth = 0.5, straighten = false } = {}) {
  if (raw.length < 2) return raw.map((p) => p.slice());
  const spacing = 0.1;
  let pts = resample(raw, spacing);
  pts = gaussianSmooth(pts, smooth * 1.2, spacing);
  if (straighten && pts.length > 2 && straightness(pts) < 0.035) return [pts[0], pts[pts.length - 1]];
  return simplify(pts, 0.01 + 0.02 * smooth);
}

// ---------------- NURBS (cubic B-spline least-squares fit) ----------------

function findSpan(n, p, u, U) {
  if (u >= U[n + 1]) return n;
  if (u <= U[p]) return p;
  let lo = p, hi = n + 1, mid = (lo + hi) >> 1;
  while (u < U[mid] || u >= U[mid + 1]) {
    if (u < U[mid]) hi = mid; else lo = mid;
    mid = (lo + hi) >> 1;
  }
  return mid;
}
function basisFuns(i, u, p, U) {
  const N = [1], left = [], right = [];
  for (let j = 1; j <= p; j++) {
    left[j] = u - U[i + 1 - j];
    right[j] = U[i + j] - u;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      const tmp = N[r] / (right[r + 1] + left[j - r]);
      N[r] = saved + right[r + 1] * tmp;
      saved = left[j - r] * tmp;
    }
    N[j] = saved;
  }
  return N;
}
export function evalBSpline(curve, u) {
  const { degree: p, knots: U, ctrl: P } = curve;
  const n = P.length - 1;
  const span = findSpan(n, p, u, U);
  const N = basisFuns(span, u, p, U);
  const C = [0, 0, 0];
  for (let j = 0; j <= p; j++) {
    const Pj = P[span - p + j];
    C[0] += N[j] * Pj[0]; C[1] += N[j] * Pj[1]; C[2] += N[j] * Pj[2];
  }
  return C;
}

function solveDense(A, b, n) {
  const a = A.map((r) => r.slice()), x = b.map((r) => r.slice());
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    [a[c], a[p]] = [a[p], a[c]]; [x[c], x[p]] = [x[p], x[c]];
    const d = a[c][c];
    if (Math.abs(d) < 1e-14) return null;
    for (let r = c + 1; r < n; r++) {
      const f = a[r][c] / d;
      if (!f) continue;
      for (let k = c; k < n; k++) a[r][k] -= f * a[c][k];
      for (let k = 0; k < 3; k++) x[r][k] -= f * x[c][k];
    }
  }
  for (let r = n - 1; r >= 0; r--) {
    for (let k = r + 1; k < n; k++) for (let j = 0; j < 3; j++) x[r][j] -= a[r][k] * x[k][j];
    for (let j = 0; j < 3; j++) x[r][j] /= a[r][r];
  }
  return x;
}

/**
 * Least-squares cubic B-spline through Q with clamped ends (Piegl & Tiller A9.7).
 * Returns {degree, ctrl:[[x,y,z]], knots:[full clamped vector, length n+p+2]}.
 */
export function fitNurbs(Q, { smooth = 0.5 } = {}) {
  const p = 3;
  if (Q.length < 2) return null;
  if (Q.length === 2 || polylineLength(Q) < 1e-6) {
    // straight line as a degree-1 curve
    return { degree: 1, ctrl: [Q[0].slice(), Q[Q.length - 1].slice()], knots: [0, 0, 1, 1] };
  }
  const pts = resample(Q, 0.1);
  const m = pts.length - 1;
  const L = polylineLength(pts);
  const span = 0.8 + 2.2 * smooth; // cm of curve per control point
  let n = Math.max(p, Math.min(Math.ceil(L / span) + p - 1, Math.min(150, m - 1))); // n+1 control points
  if (m < p + 1) {
    // too few samples for a cubic: degree-1 through the points
    const knots = [0];
    const d = []; let acc = 0;
    for (let i = 0; i <= m; i++) { if (i) acc += v3.dist(pts[i - 1], pts[i]); d.push(acc / L); }
    return { degree: 1, ctrl: pts.map((q) => q.slice()), knots: [0, ...d, 1] };
  }
  // chord-length parameters
  const u = [0];
  let acc = 0;
  for (let k = 1; k <= m; k++) { acc += v3.dist(pts[k - 1], pts[k]); u.push(acc / L); }
  u[m] = 1;
  // knot vector by averaging
  const U = new Array(n + p + 2);
  for (let i = 0; i <= p; i++) { U[i] = 0; U[n + 1 + i] = 1; }
  const dd = (m + 1) / (n - p + 1);
  for (let j = 1; j <= n - p; j++) {
    const i = Math.floor(j * dd), a = j * dd - i;
    U[p + j] = (1 - a) * u[i - 1] + a * u[i];
  }
  // basis rows
  const rows = [];
  for (let k = 1; k < m; k++) {
    const s = findSpan(n, p, u[k], U);
    rows.push({ s, N: basisFuns(s, u[k], p, U) });
  }
  const Nik = (row, i) => { const j = i - (row.s - p); return j >= 0 && j <= p ? row.N[j] : 0; };
  const size = n - 1;
  const NtN = Array.from({ length: size }, () => new Array(size).fill(0));
  const R = Array.from({ length: size }, () => [0, 0, 0]);
  rows.forEach((row, idx) => {
    const k = idx + 1;
    const N0 = Nik(row, 0), Nn = Nik(row, n);
    const Rk = [0, 1, 2].map((j) => pts[k][j] - N0 * pts[0][j] - Nn * pts[m][j]);
    for (let a = Math.max(1, row.s - p); a <= Math.min(n - 1, row.s); a++) {
      const Na = Nik(row, a);
      if (!Na) continue;
      for (let j = 0; j < 3; j++) R[a - 1][j] += Na * Rk[j];
      for (let b = Math.max(1, row.s - p); b <= Math.min(n - 1, row.s); b++) NtN[a - 1][b - 1] += Na * Nik(row, b);
    }
  });
  const P = solveDense(NtN, R, size);
  if (!P) return { degree: 1, ctrl: Q.map((q) => q.slice()), knots: null };
  return { degree: p, ctrl: [pts[0].slice(), ...P, pts[m].slice()], knots: U };
}

/** Sample a fitted curve as a polyline (for preview / checks). */
export function sampleNurbs(curve, n = 100) {
  if (!curve.knots) return curve.ctrl;
  const out = [];
  for (let i = 0; i <= n; i++) out.push(evalBSpline(curve, i / n));
  return out;
}

// ---------------- Tube mesh ----------------

/**
 * Build a tube around a polyline. Returns {positions:Float32Array, normals:Float32Array, indices:Uint32Array}.
 * radius in cm. Caps: flat discs at both ends.
 */
export function tubeMesh(pts, radius, radial = 8, caps = true) {
  const P = [];
  for (const p of pts) if (!P.length || v3.dist(p, P[P.length - 1]) > 1e-5) P.push(p);
  if (P.length < 2) {
    if (!P.length) return { positions: new Float32Array(0), normals: new Float32Array(0), indices: new Uint32Array(0) };
    P.push(v3.add(P[0], [radius * 0.01, 0, 0]));
  }
  const n = P.length;
  const T = [];
  for (let i = 0; i < n; i++) {
    const a = P[Math.max(0, i - 1)], b = P[Math.min(n - 1, i + 1)];
    T.push(v3.norm(v3.sub(b, a)));
  }
  // initial normal
  let ref = Math.abs(T[0][2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  let N = v3.norm(v3.cross(T[0], ref));
  const pos = [], nor = [], idx = [];
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      // parallel transport
      const ax = v3.cross(T[i - 1], T[i]);
      const s = v3.len(ax);
      if (s > 1e-8) {
        const k = v3.scale(ax, 1 / s), c = v3.dot(T[i - 1], T[i]), ang = Math.atan2(s, c);
        const cs = Math.cos(ang), sn = Math.sin(ang);
        N = v3.add(v3.add(v3.scale(N, cs), v3.scale(v3.cross(k, N), sn)), v3.scale(k, v3.dot(k, N) * (1 - cs)));
      }
      N = v3.norm(v3.sub(N, v3.scale(T[i], v3.dot(N, T[i]))));
    }
    const B = v3.cross(T[i], N);
    for (let j = 0; j < radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      const d = v3.add(v3.scale(N, Math.cos(a)), v3.scale(B, Math.sin(a)));
      pos.push(P[i][0] + d[0] * radius, P[i][1] + d[1] * radius, P[i][2] + d[2] * radius);
      nor.push(d[0], d[1], d[2]);
    }
  }
  for (let i = 0; i < n - 1; i++)
    for (let j = 0; j < radial; j++) {
      const a = i * radial + j, b = i * radial + ((j + 1) % radial), c = a + radial, d = b + radial;
      idx.push(a, b, c, b, d, c); // CCW seen from outside
    }
  if (caps) {
    for (const [end, sign] of [[0, -1], [n - 1, 1]]) {
      const ci = pos.length / 3;
      pos.push(...P[end]);
      nor.push(...v3.scale(T[end], sign));
      const base = pos.length / 3;
      for (let j = 0; j < radial; j++) {
        const k = (end * radial + j) * 3;
        pos.push(pos[k], pos[k + 1], pos[k + 2]);
        nor.push(...v3.scale(T[end], sign));
      }
      for (let j = 0; j < radial; j++) {
        const a = base + j, b = base + ((j + 1) % radial);
        if (sign < 0) idx.push(ci, b, a); else idx.push(ci, a, b);
      }
    }
  }
  return { positions: new Float32Array(pos), normals: new Float32Array(nor), indices: new Uint32Array(idx) };
}

export function bbox(pointLists) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const pts of pointLists)
    for (const p of pts)
      for (let k = 0; k < 3; k++) { if (p[k] < min[k]) min[k] = p[k]; if (p[k] > max[k]) max[k] = p[k]; }
  return isFinite(min[0]) ? { min, max } : null;
}
