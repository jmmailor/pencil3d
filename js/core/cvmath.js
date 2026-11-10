/*
 * Small computer-vision maths kit: homography, planar pose, Levenberg–Marquardt pose
 * refinement, rotation helpers, sub-pixel corner refinement and pivot calibration.
 * Classic script (works in a worker via importScripts and on the main thread).
 * Rotations are row-major 3x3 arrays [r00,r01,r02,r10,...]. Pose maps object -> camera:
 *   Xc = R * Xo + t     (OpenCV camera: x right, y down, z forward)
 */
(function (G) {
  const P3D = (G.P3D = G.P3D || {});
  const M = (P3D.M = {});

  // ---------- vectors / 3x3 ----------
  M.sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  M.add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  M.scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  M.dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  M.cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  M.norm = (a) => Math.hypot(a[0], a[1], a[2]);
  M.normalize = (a) => { const n = M.norm(a) || 1; return [a[0] / n, a[1] / n, a[2] / n]; };
  M.mulMV = (R, v) => [
    R[0] * v[0] + R[1] * v[1] + R[2] * v[2],
    R[3] * v[0] + R[4] * v[1] + R[5] * v[2],
    R[6] * v[0] + R[7] * v[1] + R[8] * v[2],
  ];
  M.mulMtV = (R, v) => [
    R[0] * v[0] + R[3] * v[1] + R[6] * v[2],
    R[1] * v[0] + R[4] * v[1] + R[7] * v[2],
    R[2] * v[0] + R[5] * v[1] + R[8] * v[2],
  ];
  M.mulMM = (A, B) => {
    const C = new Array(9);
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++)
        C[i * 3 + j] = A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j];
    return C;
  };
  M.transpose = (R) => [R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]];
  M.det3 = (A) =>
    A[0] * (A[4] * A[8] - A[5] * A[7]) - A[1] * (A[3] * A[8] - A[5] * A[6]) + A[2] * (A[3] * A[7] - A[4] * A[6]);
  M.inv3 = (A) => {
    const d = M.det3(A);
    if (Math.abs(d) < 1e-15) return null;
    const i = 1 / d;
    return [
      (A[4] * A[8] - A[5] * A[7]) * i, (A[2] * A[7] - A[1] * A[8]) * i, (A[1] * A[5] - A[2] * A[4]) * i,
      (A[5] * A[6] - A[3] * A[8]) * i, (A[0] * A[8] - A[2] * A[6]) * i, (A[2] * A[3] - A[0] * A[5]) * i,
      (A[3] * A[7] - A[4] * A[6]) * i, (A[1] * A[6] - A[0] * A[7]) * i, (A[0] * A[4] - A[1] * A[3]) * i,
    ];
  };
  M.fromCols = (a, b, c) => [a[0], b[0], c[0], a[1], b[1], c[1], a[2], b[2], c[2]];
  M.col = (R, j) => [R[j], R[3 + j], R[6 + j]];

  /** Nearest rotation matrix (polar decomposition by Newton iteration). */
  M.orthonormalize = (A) => {
    let R = A.slice();
    if (M.det3(R) < 0) R = R.map((x) => -x);
    for (let k = 0; k < 20; k++) {
      const Ri = M.inv3(R);
      if (!Ri) break;
      const RiT = M.transpose(Ri);
      let diff = 0;
      const N = R.map((x, i) => { const v = 0.5 * (x + RiT[i]); diff += Math.abs(v - x); return v; });
      R = N;
      if (diff < 1e-12) break;
    }
    return R;
  };

  /** exp map: rotation vector -> matrix */
  M.rodrigues = (r) => {
    const th = M.norm(r);
    if (th < 1e-12) return [1, -r[2], r[1], r[2], 1, -r[0], -r[1], r[0], 1];
    const k = [r[0] / th, r[1] / th, r[2] / th];
    const c = Math.cos(th), s = Math.sin(th), v = 1 - c;
    return [
      c + k[0] * k[0] * v, k[0] * k[1] * v - k[2] * s, k[0] * k[2] * v + k[1] * s,
      k[1] * k[0] * v + k[2] * s, c + k[1] * k[1] * v, k[1] * k[2] * v - k[0] * s,
      k[2] * k[0] * v - k[1] * s, k[2] * k[1] * v + k[0] * s, c + k[2] * k[2] * v,
    ];
  };

  /** log map: matrix -> rotation vector */
  M.logRot = (R) => {
    const tr = R[0] + R[4] + R[8];
    const c = Math.max(-1, Math.min(1, (tr - 1) / 2));
    const th = Math.acos(c);
    if (th < 1e-9) return [(R[7] - R[5]) / 2, (R[2] - R[6]) / 2, (R[3] - R[1]) / 2];
    if (Math.PI - th < 1e-6) {
      // axis from the largest diagonal entry
      const xx = (R[0] + 1) / 2, yy = (R[4] + 1) / 2, zz = (R[8] + 1) / 2;
      let ax;
      if (xx >= yy && xx >= zz) { const x = Math.sqrt(xx); ax = [x, R[1] / (2 * x), R[2] / (2 * x)]; }
      else if (yy >= zz) { const y = Math.sqrt(yy); ax = [R[1] / (2 * y), y, R[5] / (2 * y)]; }
      else { const z = Math.sqrt(zz); ax = [R[2] / (2 * z), R[5] / (2 * z), z]; }
      return M.scale(M.normalize(ax), th);
    }
    const s = th / (2 * Math.sin(th));
    return [(R[7] - R[5]) * s, (R[2] - R[6]) * s, (R[3] - R[1]) * s];
  };

  /** angle (rad) between two rotations */
  M.rotAngle = (A, B) => M.norm(M.logRot(M.mulMM(A, M.transpose(B))));

  /** Rotation that takes unit vector a onto unit vector b. */
  M.rotBetween = (a, b) => {
    const v = M.cross(a, b), s = M.norm(v), c = M.dot(a, b);
    if (s < 1e-12) {
      if (c > 0) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
      // 180 deg about any axis orthogonal to a
      const o = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
      return M.rodrigues(M.scale(M.normalize(M.cross(a, o)), Math.PI));
    }
    return M.rodrigues(M.scale(v, Math.atan2(s, c) / s));
  };

  M.quatFromRot = (R) => {
    const tr = R[0] + R[4] + R[8];
    let x, y, z, w;
    if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; w = s / 4; x = (R[7] - R[5]) / s; y = (R[2] - R[6]) / s; z = (R[3] - R[1]) / s; }
    else if (R[0] > R[4] && R[0] > R[8]) { const s = Math.sqrt(1 + R[0] - R[4] - R[8]) * 2; w = (R[7] - R[5]) / s; x = s / 4; y = (R[1] + R[3]) / s; z = (R[2] + R[6]) / s; }
    else if (R[4] > R[8]) { const s = Math.sqrt(1 + R[4] - R[0] - R[8]) * 2; w = (R[2] - R[6]) / s; x = (R[1] + R[3]) / s; y = s / 4; z = (R[5] + R[7]) / s; }
    else { const s = Math.sqrt(1 + R[8] - R[0] - R[4]) * 2; w = (R[3] - R[1]) / s; x = (R[2] + R[6]) / s; y = (R[5] + R[7]) / s; z = s / 4; }
    return [x, y, z, w];
  };
  M.rotFromQuat = (q) => {
    const [x, y, z, w] = q;
    return [
      1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
      2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
      2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
    ];
  };

  // ---------- small dense linear algebra ----------
  /** Solve A x = b (A n×n flat, row-major) by Gaussian elimination with partial pivoting. */
  M.solve = (A, b, n) => {
    const a = A.slice(), x = b.slice();
    for (let c = 0; c < n; c++) {
      let p = c, best = Math.abs(a[c * n + c]);
      for (let r = c + 1; r < n; r++) { const v = Math.abs(a[r * n + c]); if (v > best) { best = v; p = r; } }
      if (best < 1e-18) return null;
      if (p !== c) {
        for (let k = 0; k < n; k++) { const t = a[c * n + k]; a[c * n + k] = a[p * n + k]; a[p * n + k] = t; }
        const t = x[c]; x[c] = x[p]; x[p] = t;
      }
      const d = a[c * n + c];
      for (let r = c + 1; r < n; r++) {
        const f = a[r * n + c] / d;
        if (f === 0) continue;
        for (let k = c; k < n; k++) a[r * n + k] -= f * a[c * n + k];
        x[r] -= f * x[c];
      }
    }
    for (let r = n - 1; r >= 0; r--) {
      let s = x[r];
      for (let k = r + 1; k < n; k++) s -= a[r * n + k] * x[k];
      x[r] = s / a[r * n + r];
    }
    return x;
  };

  /** Jacobi eigen-decomposition of a symmetric n×n matrix. Returns {values, vectors(col-major list)} */
  M.eigSym = (S, n) => {
    const a = S.slice();
    const v = new Array(n * n).fill(0);
    for (let i = 0; i < n; i++) v[i * n + i] = 1;
    for (let sweep = 0; sweep < 60; sweep++) {
      let off = 0;
      for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p * n + q] * a[p * n + q];
      if (off < 1e-22) break;
      for (let p = 0; p < n; p++) {
        for (let q = p + 1; q < n; q++) {
          const apq = a[p * n + q];
          if (Math.abs(apq) < 1e-300) continue;
          const app = a[p * n + p], aqq = a[q * n + q];
          const theta = (aqq - app) / (2 * apq);
          const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
          const c = 1 / Math.sqrt(t * t + 1), s = t * c;
          for (let k = 0; k < n; k++) {
            const akp = a[k * n + p], akq = a[k * n + q];
            a[k * n + p] = c * akp - s * akq;
            a[k * n + q] = s * akp + c * akq;
          }
          for (let k = 0; k < n; k++) {
            const apk = a[p * n + k], aqk = a[q * n + k];
            a[p * n + k] = c * apk - s * aqk;
            a[q * n + k] = s * apk + c * aqk;
          }
          for (let k = 0; k < n; k++) {
            const vkp = v[k * n + p], vkq = v[k * n + q];
            v[k * n + p] = c * vkp - s * vkq;
            v[k * n + q] = s * vkp + c * vkq;
          }
        }
      }
    }
    const values = [], vectors = [];
    for (let i = 0; i < n; i++) {
      values.push(a[i * n + i]);
      const col = [];
      for (let k = 0; k < n; k++) col.push(v[k * n + i]);
      vectors.push(col);
    }
    return { values, vectors };
  };

  // ---------- homography ----------
  function normTransform(pts) {
    let mx = 0, my = 0;
    for (const p of pts) { mx += p[0]; my += p[1]; }
    mx /= pts.length; my /= pts.length;
    let d = 0;
    for (const p of pts) d += Math.hypot(p[0] - mx, p[1] - my);
    d /= pts.length;
    const s = d > 1e-12 ? Math.SQRT2 / d : 1;
    return { s, mx, my };
  }

  /** DLT homography mapping src (x,y) -> dst (u,v). Returns flat 3x3 or null. */
  M.homography = (src, dst) => {
    const n = src.length;
    if (n < 4) return null;
    const Ts = normTransform(src), Td = normTransform(dst);
    const AtA = new Array(81).fill(0);
    const row = new Array(9);
    const acc = () => {
      for (let i = 0; i < 9; i++) {
        const ri = row[i];
        if (ri === 0) continue;
        for (let j = i; j < 9; j++) AtA[i * 9 + j] += ri * row[j];
      }
    };
    for (let k = 0; k < n; k++) {
      const x = (src[k][0] - Ts.mx) * Ts.s, y = (src[k][1] - Ts.my) * Ts.s;
      const u = (dst[k][0] - Td.mx) * Td.s, v = (dst[k][1] - Td.my) * Td.s;
      row[0] = -x; row[1] = -y; row[2] = -1; row[3] = 0; row[4] = 0; row[5] = 0; row[6] = u * x; row[7] = u * y; row[8] = u; acc();
      row[0] = 0; row[1] = 0; row[2] = 0; row[3] = -x; row[4] = -y; row[5] = -1; row[6] = v * x; row[7] = v * y; row[8] = v; acc();
    }
    for (let i = 0; i < 9; i++) for (let j = 0; j < i; j++) AtA[i * 9 + j] = AtA[j * 9 + i];
    const { values, vectors } = M.eigSym(AtA, 9);
    let mi = 0;
    for (let i = 1; i < 9; i++) if (values[i] < values[mi]) mi = i;
    const h = vectors[mi];
    // H = Td^-1 * Hn * Ts
    const Hn = h;
    const TsM = [Ts.s, 0, -Ts.s * Ts.mx, 0, Ts.s, -Ts.s * Ts.my, 0, 0, 1];
    const TdInv = [1 / Td.s, 0, Td.mx, 0, 1 / Td.s, Td.my, 0, 0, 1];
    const H = M.mulMM(TdInv, M.mulMM(Hn, TsM));
    const sN = H[8] !== 0 ? 1 / H[8] : 1;
    return H.map((x) => x * sN);
  };

  /** Pose (R,t) of a z=0 plane from a homography and intrinsics K={f,cx,cy}. */
  M.poseFromHomography = (H, K) => {
    const a1 = [(H[0] - K.cx * H[6]) / K.f, (H[3] - K.cy * H[6]) / K.f, H[6]];
    const a2 = [(H[1] - K.cx * H[7]) / K.f, (H[4] - K.cy * H[7]) / K.f, H[7]];
    const a3 = [(H[2] - K.cx * H[8]) / K.f, (H[5] - K.cy * H[8]) / K.f, H[8]];
    let lam = 2 / (M.norm(a1) + M.norm(a2));
    if (a3[2] * lam < 0) lam = -lam;
    const r1 = M.scale(a1, lam), r2 = M.scale(a2, lam), t = M.scale(a3, lam);
    const R = M.orthonormalize(M.fromCols(r1, r2, M.cross(r1, r2)));
    return { R, t };
  };

  /**
   * Focal-length constraint from a plane homography, assuming principal point at (cx,cy)
   * and square pixels. Returns {a,b}: f^2 ≈ -a/b (least squares over frames: f² = -Σab/Σb²).
   */
  M.focalConstraint = (H, cx, cy) => {
    // centre the image coordinates
    const h = [H[0] - cx * H[6], H[1] - cx * H[7], H[3] - cy * H[6], H[4] - cy * H[7], H[6], H[7]];
    const [h11, h12, h21, h22, h31, h32] = h;
    const nrm = Math.hypot(...h) || 1;
    const k = 1 / (nrm * nrm);
    return [
      { a: (h11 * h12 + h21 * h22) * k, b: h31 * h32 * k },
      { a: (h11 * h11 + h21 * h21 - h12 * h12 - h22 * h22) * k, b: (h31 * h31 - h32 * h32) * k },
    ];
  };

  // ---------- projection / LM ----------
  M.project = (R, t, X, K) => {
    const x = R[0] * X[0] + R[1] * X[1] + R[2] * X[2] + t[0];
    const y = R[3] * X[0] + R[4] * X[1] + R[5] * X[2] + t[1];
    const z = R[6] * X[0] + R[7] * X[1] + R[8] * X[2] + t[2];
    return [K.f * x / z + K.cx, K.f * y / z + K.cy, z];
  };

  M.reprojErrors = (R, t, obj, img, K) => {
    const e = [];
    for (let i = 0; i < obj.length; i++) {
      const p = M.project(R, t, obj[i], K);
      e.push(p[2] > 0 ? Math.hypot(p[0] - img[i][0], p[1] - img[i][1]) : 1e6);
    }
    return e;
  };

  M.rms = (errs) => Math.sqrt(errs.reduce((s, e) => s + e * e, 0) / Math.max(1, errs.length));

  /** Levenberg–Marquardt refinement of a pose over 2D–3D correspondences. */
  M.refinePose = (R0, t0, obj, img, K, iters = 15) => {
    let R = R0.slice(), t = t0.slice();
    let lambda = 1e-3;
    const n = obj.length;
    const cost = (R, t) => {
      let c = 0;
      for (let i = 0; i < n; i++) {
        const p = M.project(R, t, obj[i], K);
        if (p[2] <= 0) return Infinity;
        const du = p[0] - img[i][0], dv = p[1] - img[i][1];
        c += du * du + dv * dv;
      }
      return c;
    };
    let c0 = cost(R, t);
    for (let it = 0; it < iters; it++) {
      const JtJ = new Array(36).fill(0), Jtr = new Array(6).fill(0);
      for (let i = 0; i < n; i++) {
        const X = obj[i];
        const RX = M.mulMV(R, X);
        const xc = RX[0] + t[0], yc = RX[1] + t[1], zc = RX[2] + t[2];
        if (zc <= 1e-6) continue;
        const iz = 1 / zc, iz2 = iz * iz;
        const ru = K.f * xc * iz + K.cx - img[i][0];
        const rv = K.f * yc * iz + K.cy - img[i][1];
        // d(u,v)/d(Xc)
        const du = [K.f * iz, 0, -K.f * xc * iz2];
        const dv = [0, K.f * iz, -K.f * yc * iz2];
        // dXc/dω = -[RX]x ;  dXc/dt = I
        const sk = [0, RX[2], -RX[1], -RX[2], 0, RX[0], RX[1], -RX[0], 0]; // -[RX]x
        const Ju = new Array(6), Jv = new Array(6);
        for (let j = 0; j < 3; j++) {
          Ju[j] = du[0] * sk[j] + du[1] * sk[3 + j] + du[2] * sk[6 + j];
          Jv[j] = dv[0] * sk[j] + dv[1] * sk[3 + j] + dv[2] * sk[6 + j];
          Ju[3 + j] = du[j];
          Jv[3 + j] = dv[j];
        }
        for (let a = 0; a < 6; a++) {
          Jtr[a] += Ju[a] * ru + Jv[a] * rv;
          for (let b = a; b < 6; b++) JtJ[a * 6 + b] += Ju[a] * Ju[b] + Jv[a] * Jv[b];
        }
      }
      for (let a = 0; a < 6; a++) for (let b = 0; b < a; b++) JtJ[a * 6 + b] = JtJ[b * 6 + a];
      let improved = false;
      for (let tries = 0; tries < 6; tries++) {
        const A = JtJ.slice();
        for (let a = 0; a < 6; a++) A[a * 7] *= 1 + lambda;
        const d = M.solve(A, Jtr.map((x) => -x), 6);
        if (!d) { lambda *= 10; continue; }
        const Rn = M.mulMM(M.rodrigues([d[0], d[1], d[2]]), R);
        const tn = [t[0] + d[3], t[1] + d[4], t[2] + d[5]];
        const c1 = cost(Rn, tn);
        if (c1 < c0) {
          const rel = (c0 - c1) / (c0 || 1);
          R = Rn; t = tn; c0 = c1; lambda = Math.max(1e-7, lambda / 10); improved = true;
          if (rel < 1e-10) it = iters;
          break;
        }
        lambda *= 10;
      }
      if (!improved) break;
    }
    return { R: M.orthonormalize(R), t, rms: Math.sqrt(c0 / Math.max(1, n)) };
  };

  /**
   * The second (mirror) solution of the planar pose ambiguity: reflect the plane normal
   * about the viewing ray to the plane centre and rotate accordingly.
   */
  M.flipPlanarPose = (R, t) => {
    const n = M.col(R, 2);
    const v = M.normalize(t);
    const n2 = M.normalize(M.sub(M.scale(v, 2 * M.dot(n, v)), n));
    return { R: M.mulMM(M.rotBetween(n, n2), R), t: t.slice() };
  };

  // ---------- sub-pixel corner refinement ----------
  function bilinear(g, W, H, x, y) {
    if (x < 0 || y < 0 || x >= W - 1 || y >= H - 1) return -1;
    const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0;
    const i = y0 * W + x0;
    return (g[i] * (1 - fx) + g[i + 1] * fx) * (1 - fy) + (g[i + W] * (1 - fx) + g[i + W + 1] * fx) * fy;
  }

  /**
   * Refine a quad's corners: fit a line to the strongest-gradient edge points along each side,
   * then intersect neighbouring lines. corners: [[x,y] x4]. Returns new corners (or the input).
   */
  M.refineQuad = (g, W, H, q) => {
    const lines = [];
    let minLen = Infinity;
    for (let i = 0; i < 4; i++) {
      const p0 = q[i], p1 = q[(i + 1) % 4];
      const dx = p1[0] - p0[0], dy = p1[1] - p0[1];
      const L = Math.hypot(dx, dy);
      minLen = Math.min(minLen, L);
      if (L < 8) return q;
      const ux = dx / L, uy = dy / L, nx = -uy, ny = ux;
      const r = Math.max(1.5, Math.min(4, L / 14));
      const nS = Math.max(6, Math.min(24, Math.round(L / 3)));
      const pts = [];
      for (let k = 0; k < nS; k++) {
        const tt = 0.12 + (0.76 * k) / (nS - 1);
        const cx = p0[0] + dx * tt, cy = p0[1] + dy * tt;
        const step = 0.5, N = Math.round((2 * r) / step) + 1;
        let prev = bilinear(g, W, H, cx - nx * r, cy - ny * r);
        if (prev < 0) continue;
        const grads = [];
        let ok = true;
        for (let s = 1; s < N; s++) {
          const off = -r + s * step;
          const val = bilinear(g, W, H, cx + nx * off, cy + ny * off);
          if (val < 0) { ok = false; break; }
          grads.push(Math.abs(val - prev));
          prev = val;
        }
        if (!ok) continue;
        let bi = 0;
        for (let s = 1; s < grads.length; s++) if (grads[s] > grads[bi]) bi = s;
        if (grads[bi] < 6) continue; // too weak
        let sub = 0;
        if (bi > 0 && bi < grads.length - 1) {
          const a = grads[bi - 1], b = grads[bi], c = grads[bi + 1];
          const den = a - 2 * b + c;
          if (den !== 0) sub = Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den));
        }
        // gradient sample bi sits between samples bi and bi+1
        const off = -r + (bi + 0.5 + sub) * step;
        pts.push([cx + nx * off, cy + ny * off]);
      }
      if (pts.length < 4) return q;
      // PCA line fit
      let mx = 0, my = 0;
      for (const p of pts) { mx += p[0]; my += p[1]; }
      mx /= pts.length; my /= pts.length;
      let sxx = 0, sxy = 0, syy = 0;
      for (const p of pts) { const ax = p[0] - mx, ay = p[1] - my; sxx += ax * ax; sxy += ax * ay; syy += ay * ay; }
      const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
      lines.push({ p: [mx, my], d: [Math.cos(ang), Math.sin(ang)] });
    }
    const out = [];
    const maxMove = Math.max(1.5, Math.min(4, minLen / 12));
    for (let i = 0; i < 4; i++) {
      const A = lines[(i + 3) % 4], B = lines[i];
      const den = A.d[0] * B.d[1] - A.d[1] * B.d[0];
      if (Math.abs(den) < 1e-6) return q;
      const wx = B.p[0] - A.p[0], wy = B.p[1] - A.p[1];
      const s = (wx * B.d[1] - wy * B.d[0]) / den;
      const c = [A.p[0] + A.d[0] * s, A.p[1] + A.d[1] * s];
      if (Math.hypot(c[0] - q[i][0], c[1] - q[i][1]) > maxMove) return q;
      out.push(c);
    }
    return out;
  };

  // ---------- pivot calibration ----------
  /**
   * Given poses (R_i, t_i) of the pen cube in the world frame while the tip stays on one spot,
   * solve R_i * p + t_i = q  for the tip offset p (cube frame) and the pivot q (world).
   */
  M.pivotCalibration = (poses) => {
    const n = poses.length;
    if (n < 10) return null;
    const AtA = new Array(36).fill(0), Atb = new Array(6).fill(0);
    for (const { R, t } of poses) {
      for (let r = 0; r < 3; r++) {
        const row = [R[r * 3], R[r * 3 + 1], R[r * 3 + 2], r === 0 ? -1 : 0, r === 1 ? -1 : 0, r === 2 ? -1 : 0];
        const b = -t[r];
        for (let a = 0; a < 6; a++) {
          Atb[a] += row[a] * b;
          for (let c = 0; c < 6; c++) AtA[a * 6 + c] += row[a] * row[c];
        }
      }
    }
    const x = M.solve(AtA, Atb, 6);
    if (!x) return null;
    const p = [x[0], x[1], x[2]], q = [x[3], x[4], x[5]];
    let s = 0;
    for (const { R, t } of poses) {
      const w = M.add(M.mulMV(R, p), t);
      const d = M.sub(w, q);
      s += M.dot(d, d);
    }
    // spread of orientations — calibration is only meaningful if the pen was tilted around
    let maxAng = 0;
    for (const { R } of poses) maxAng = Math.max(maxAng, M.rotAngle(R, poses[0].R));
    return { tip: p, pivot: q, rms: Math.sqrt(s / n), spreadDeg: (maxAng * 180) / Math.PI };
  };
})(typeof self !== 'undefined' ? self : globalThis);
