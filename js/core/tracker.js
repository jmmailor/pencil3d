/*
 * Tracker: finds the desk board and the pen cube in an RGBA frame and returns their poses.
 * Requires (globals): CV, AR (js-aruco2), P3D.M (cvmath.js), P3D layouts (markers.js).
 */
(function (G) {
  const P3D = (G.P3D = G.P3D || {});
  const M = P3D.M;

  class Tracker {
    constructor(cfg = {}) {
      this.detector = new G.AR.Detector({ dictionaryName: P3D.DICT_NAME, maxHammingDistance: 1 });
      this.prevPen = null;
      this.prevBoard = null;
      this.cfg = {};
      this.configure(Object.assign({ paper: 'a4', cubeSize: 3.0, f: null, refine: true }, cfg));
    }

    configure(cfg) {
      Object.assign(this.cfg, cfg);
      this.board = P3D.boardLayout(this.cfg.paper);
      this.cube = P3D.cubeLayout(this.cfg.cubeSize);
      this.prevPen = null;
    }

    intrinsics(W, H) {
      // default: 65° field of view across the long side of the frame (iPhone wide camera, video mode)
      const f = this.cfg.f || (Math.max(W, H) / 2) / Math.tan((65 * Math.PI) / 360);
      return { f, cx: (W - 1) / 2, cy: (H - 1) / 2 };
    }

    ensureBuffers(W, H) {
      const d = this.detector;
      if (!d.grey.data || d.grey.data.length !== W * H) {
        d.grey = new G.CV.Image(W, H, new Uint8ClampedArray(W * H));
        d.thres = new G.CV.Image(W, H, new Uint8ClampedArray(W * H));
      }
    }

    process(img) {
      const W = img.width, H = img.height;
      const t0 = (G.performance || Date).now();
      this.ensureBuffers(W, H);
      const K = this.intrinsics(W, H);
      let markers = this.detector.detect(img);
      const grey = this.detector.grey.data;

      const det = [];
      for (const mk of markers) {
        const known = this.board.byId[mk.id] || this.cube.byId[mk.id];
        if (!known) continue;
        let c = mk.corners.map((p) => [p.x, p.y]);
        if (this.cfg.refine) c = M.refineQuad(grey, W, H, c);
        det.push({ id: mk.id, corners: c, onBoard: !!this.board.byId[mk.id] });
      }
      // a marker id should appear only once; drop duplicates (ambiguous)
      const count = {};
      for (const d of det) count[d.id] = (count[d.id] || 0) + 1;
      const uniq = det.filter((d) => count[d.id] === 1);

      const board = this.solveBoard(uniq.filter((d) => d.onBoard), K);
      const pen = this.solvePen(uniq.filter((d) => !d.onBoard), K);
      const t1 = (G.performance || Date).now();
      return {
        W, H, K, board, pen,
        markers: uniq.map((d) => ({ id: d.id, c: d.corners })),
        ms: t1 - t0,
      };
    }

    solveBoard(list, K) {
      if (!list.length) return null;
      let obj = [], img = [], owner = [];
      for (const d of list) {
        const mk = this.board.byId[d.id];
        for (let k = 0; k < 4; k++) { obj.push(mk.corners[k]); img.push(d.corners[k]); owner.push(d.id); }
      }
      const H = M.homography(obj.map((p) => [p[0], p[1]]), img);
      if (!H) return null;
      let { R, t } = M.poseFromHomography(H, K);
      let res = M.refinePose(R, t, obj, img, K, 20);
      // outlier rejection per marker
      if (list.length >= 3) {
        const errs = M.reprojErrors(res.R, res.t, obj, img, K);
        const per = {};
        owner.forEach((id, i) => { per[id] = Math.max(per[id] || 0, errs[i]); });
        const vals = Object.values(per).sort((a, b) => a - b);
        const med = vals[vals.length >> 1];
        const bad = new Set(Object.keys(per).filter((id) => per[id] > Math.max(3, 4 * med)).map(Number));
        if (bad.size && bad.size < list.length - 1) {
          const keep = owner.map((id) => !bad.has(id));
          obj = obj.filter((_, i) => keep[i]); img = img.filter((_, i) => keep[i]);
          res = M.refinePose(res.R, res.t, obj, img, K, 20);
        }
      }
      // single marker: planar ambiguity — try the flipped solution too
      if (list.length === 1) {
        const alt = M.flipPlanarPose(res.R, res.t);
        const resAlt = M.refinePose(alt.R, alt.t, obj, img, K, 20);
        if (resAlt.rms < res.rms * 0.8) res = resAlt;
        else if (this.prevBoard && resAlt.rms < res.rms * 1.5 &&
          M.rotAngle(resAlt.R, this.prevBoard.R) < M.rotAngle(res.R, this.prevBoard.R)) res = resAlt;
      }
      if (res.rms > 4) return null;
      const fc = M.focalConstraint(H, K.cx, K.cy);
      this.prevBoard = res;
      return { R: res.R, t: res.t, rms: res.rms, n: obj.length / 4, focal: fc };
    }

    solvePen(list, K) {
      if (!list.length) { this.prevPen = null; return null; }
      const obj = [], img = [];
      for (const d of list) {
        const mk = this.cube.byId[d.id];
        for (let k = 0; k < 4; k++) { obj.push(mk.corners[k]); img.push(d.corners[k]); }
      }
      const cands = [];
      for (const d of list) {
        const mk = this.cube.byId[d.id];
        const c = mk.corners;
        const o = [0, 1, 2].map((j) => (c[0][j] + c[1][j] + c[2][j] + c[3][j]) / 4);
        const u = M.normalize(M.sub(c[1], c[0]));
        const v = M.normalize(M.sub(c[3], c[0]));
        const w = M.cross(u, v);
        const A = M.fromCols(u, v, w); // face-local -> cube
        const half = M.norm(M.sub(c[1], c[0])) / 2;
        const local = [[-half, -half], [half, -half], [half, half], [-half, half]];
        const Hf = M.homography(local, d.corners);
        if (!Hf) continue;
        const p1 = M.poseFromHomography(Hf, K);
        for (const pf of [p1, M.flipPlanarPose(p1.R, p1.t)]) {
          const R = M.mulMM(pf.R, M.transpose(A));
          const t = M.sub(pf.t, M.mulMV(R, o));
          cands.push({ R, t });
        }
      }
      if (this.prevPen) cands.push({ R: this.prevPen.R, t: this.prevPen.t });
      let best = null;
      for (const c of cands) {
        const r = M.refinePose(c.R, c.t, obj, img, K, 15);
        if (!isFinite(r.rms)) continue;
        // marker faces must face the camera
        let facing = true;
        for (const d of list) {
          const mk = this.cube.byId[d.id];
          const cc = mk.corners;
          const n = M.cross(M.sub(cc[1], cc[0]), M.sub(cc[3], cc[0]));
          const ctr = [0, 1, 2].map((j) => (cc[0][j] + cc[2][j]) / 2);
          const nc = M.mulMV(r.R, n);
          const pc = M.add(M.mulMV(r.R, ctr), r.t);
          // n = u x v where (u, v) = (right, down) in the printed image, so n points INTO the cube.
          if (M.dot(nc, pc) < 0) { facing = false; break; }
        }
        if (!facing) continue;
        let score = r.rms;
        if (this.prevPen) score += 0.3 * M.rotAngle(r.R, this.prevPen.R); // mild temporal prior
        if (!best || score < best.score) best = Object.assign(r, { score });
      }
      if (!best || best.rms > 3) { this.prevPen = null; return null; }
      this.prevPen = best;
      return { R: best.R, t: best.t, rms: best.rms, faces: list.length };
    }
  }

  P3D.Tracker = Tracker;
})(typeof self !== 'undefined' ? self : globalThis);
