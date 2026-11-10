// three.js overlay: renders strokes, cursor and helpers registered to the camera image.
import * as THREE from '../vendor/three.module.js';
import { tubeMesh } from './geom.js';

const M = self.P3D.M;

export class View {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, premultipliedAlpha: true });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera();
    this.camera.matrixAutoUpdate = false;
    this.K = null; this.W = 1; this.H = 1;
    this.pose = null;

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x666666, 2.2));
    const dl = new THREE.DirectionalLight(0xffffff, 1.2);
    dl.position.set(10, -20, 40);
    this.scene.add(dl);

    this.strokeGroup = new THREE.Group();
    this.helpers = new THREE.Group();
    this.scene.add(this.strokeGroup, this.helpers);
    this.meshes = new Map(); // stroke id -> {mesh, key}

    // live stroke
    this.live = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshLambertMaterial({ color: 0xffffff }));
    this.live.frustumCulled = false;
    this.scene.add(this.live);

    // cursor: tip sphere, pencil body, shadow on the desk and a drop line
    this.cursor = new THREE.Group();
    this.tipSphere = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true }));
    this.tipSphere.renderOrder = 10;
    const lineMat = (c, o = 1) => new THREE.LineBasicMaterial({ color: c, transparent: true, opacity: o, depthTest: false });
    this.body = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), lineMat(0xffd60a, 0.9));
    this.drop = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), lineMat(0xffffff, 0.6));
    this.shadow = new THREE.Mesh(new THREE.RingGeometry(0.25, 0.4, 24), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7, depthTest: false, side: THREE.DoubleSide }));
    for (const o of [this.body, this.drop, this.shadow]) o.renderOrder = 9;
    this.cursor.add(this.tipSphere, this.body, this.drop, this.shadow);
    this.cursor.visible = false;
    this.scene.add(this.cursor);

    this.selLines = new THREE.Group();
    this.scene.add(this.selLines);
  }

  resize(cssW, cssH) {
    this.renderer.setSize(cssW, cssH, false);
  }

  setIntrinsics(K, W, H) {
    this.K = K; this.W = W; this.H = H;
    const n = 0.5, f = 2000;
    const cxg = K.cx + 0.5, cyg = K.cy + 0.5;
    this.camera.projectionMatrix.makePerspective(-cxg / K.f * n, (W - cxg) / K.f * n, cyg / K.f * n, -(H - cyg) / K.f * n, n, f);
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
  }

  /** World->camera pose in OpenCV convention. */
  setPose(R, t) {
    this.pose = { R, t };
    const Rt = M.transpose(R), C = M.scale(M.mulMV(Rt, t), -1);
    const m = this.camera.matrix;
    m.set(Rt[0], -Rt[1], -Rt[2], C[0], Rt[3], -Rt[4], -Rt[5], C[1], Rt[6], -Rt[7], -Rt[8], C[2], 0, 0, 0, 1);
    this.camera.matrixWorld.copy(m);
    this.camera.matrixWorldInverse.copy(m).invert();
  }

  // ---------- helpers: board outline, grid, axes, mirror plane
  buildHelpers(board, opts) {
    this.helpers.clear();
    const { W, H, inner } = board;
    const lineMat = (c, o) => new THREE.LineBasicMaterial({ color: c, transparent: true, opacity: o });
    const toW = (xs, ys) => new THREE.Vector3(xs - W / 2, H / 2 - ys, 0);
    // sheet outline
    const ol = [toW(0, 0), toW(W, 0), toW(W, H), toW(0, H), toW(0, 0)];
    this.helpers.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(ol), lineMat(0xffffff, 0.35)));
    if (opts.grid) {
      const minor = [], major = [];
      const x0 = inner.x0 - W / 2, x1 = inner.x1 - W / 2, y0 = H / 2 - inner.y1, y1 = H / 2 - inner.y0;
      for (let x = Math.ceil(x0); x <= x1; x++) (x % 5 ? minor : major).push(new THREE.Vector3(x, y0, 0), new THREE.Vector3(x, y1, 0));
      for (let y = Math.ceil(y0); y <= y1; y++) (y % 5 ? minor : major).push(new THREE.Vector3(x0, y, 0), new THREE.Vector3(x1, y, 0));
      this.helpers.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(minor), lineMat(0xffffff, 0.18)));
      this.helpers.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(major), lineMat(0xffffff, 0.4)));
    }
    // origin axes
    const o = opts.origin || [0, 0, 0];
    const O = new THREE.Vector3(...o);
    const ax = (d, c) => new THREE.Line(new THREE.BufferGeometry().setFromPoints([O, O.clone().add(new THREE.Vector3(...d))]),
      new THREE.LineBasicMaterial({ color: c, depthTest: false }));
    const axes = new THREE.Group();
    axes.add(ax([3, 0, 0], 0xff453a), ax([0, 3, 0], 0x30d158), ax([0, 0, 3], 0x0a84ff));
    axes.renderOrder = 5;
    this.helpers.add(axes);
    if (opts.mirror) {
      const pl = new THREE.Mesh(new THREE.PlaneGeometry(20, H), new THREE.MeshBasicMaterial({ color: 0x0a84ff, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }));
      pl.rotation.set(0, Math.PI / 2, 0);
      pl.position.set(o[0], 0, 10);
      this.helpers.add(pl);
    }
  }

  // ---------- strokes
  syncStrokes(model, selected) {
    const seen = new Set();
    for (const s of model.visibleStrokes()) {
      seen.add(s.id);
      const key = `${s.raw.length}|${s.smooth}|${s.straight}|${s.rev || 0}|${s.width}|${s.color}`;
      let e = this.meshes.get(s.id);
      if (!e || e.key !== key) {
        if (e) { this.strokeGroup.remove(e.mesh); e.mesh.geometry.dispose(); e.mesh.material.dispose(); }
        const g = this.tubeGeometry(model.pts(s), s.width / 2);
        const mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: s.color }));
        mesh.userData.id = s.id;
        this.strokeGroup.add(mesh);
        e = { mesh, key };
        this.meshes.set(s.id, e);
      }
      e.mesh.material.emissive.set(selected.has(s.id) ? 0x555555 : 0x000000);
    }
    for (const [id, e] of this.meshes) {
      if (!seen.has(id)) { this.strokeGroup.remove(e.mesh); e.mesh.geometry.dispose(); e.mesh.material.dispose(); this.meshes.delete(id); }
    }
    // selection overlay lines (visible through everything)
    this.selLines.clear();
    for (const s of model.visibleStrokes()) {
      if (!selected.has(s.id)) continue;
      const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(model.pts(s).map((p) => new THREE.Vector3(...p))),
        new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.9 }));
      l.renderOrder = 8;
      this.selLines.add(l);
    }
  }

  tubeGeometry(pts, r) {
    const t = tubeMesh(pts, r, 8, true);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(t.positions, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(t.normals, 3));
    g.setIndex(new THREE.BufferAttribute(t.indices, 1));
    return g;
  }

  setLive(pts, color, width) {
    this.live.geometry.dispose();
    this.live.geometry = pts && pts.length > 1 ? this.tubeGeometry(pts, width / 2) : new THREE.BufferGeometry();
    this.live.material.color.set(color);
  }

  setCursor(tip, cubeCenter, opts) {
    if (!tip) { this.cursor.visible = false; return; }
    this.cursor.visible = true;
    const r = Math.max(0.15, opts.width / 2 + 0.05);
    this.tipSphere.scale.setScalar(r);
    this.tipSphere.position.set(...tip);
    this.tipSphere.material.color.set(opts.drawing ? 0xff453a : opts.color);
    this.tipSphere.material.opacity = opts.stale ? 0.4 : 0.95;
    const set = (line, a, b) => {
      const p = line.geometry.attributes.position;
      p.setXYZ(0, ...a); p.setXYZ(1, ...b); p.needsUpdate = true;
      line.geometry.computeBoundingSphere();
    };
    this.body.visible = !!cubeCenter;
    if (cubeCenter) set(this.body, tip, cubeCenter);
    set(this.drop, tip, [tip[0], tip[1], 0]);
    this.drop.visible = tip[2] > 0.3;
    this.shadow.position.set(tip[0], tip[1], 0.01);
  }

  render() {
    if (!this.pose || !this.K) { this.renderer.clear(); return; }
    this.renderer.render(this.scene, this.camera);
  }

  // ---------- picking (canvas-relative CSS pixels)
  toImage(p, cssW, cssH) {
    if (!this.pose) return null;
    const q = M.project(this.pose.R, this.pose.t, p, this.K);
    if (q[2] <= 0) return null;
    return [((q[0] + 0.5) / this.W) * cssW, ((q[1] + 0.5) / this.H) * cssH, q[2]];
  }
  ray(x, y, cssW, cssH) {
    if (!this.pose) return null;
    const u = (x / cssW) * this.W - 0.5, v = (y / cssH) * this.H - 0.5;
    const dc = [(u - this.K.cx) / this.K.f, (v - this.K.cy) / this.K.f, 1];
    const { R, t } = this.pose;
    const o = M.scale(M.mulMtV(R, t), -1);
    const d = M.normalize(M.mulMtV(R, dc));
    return { o, d };
  }
  static rayPlaneZ(ray, z) {
    if (!ray || Math.abs(ray.d[2]) < 1e-6) return null;
    const s = (z - ray.o[2]) / ray.d[2];
    if (s <= 0) return null;
    return [ray.o[0] + ray.d[0] * s, ray.o[1] + ray.d[1] * s, z];
  }
  /** nearest stroke within maxPx; returns {id, point} */
  pick(model, x, y, cssW, cssH, maxPx = 24) {
    let best = null;
    for (const s of model.visibleStrokes()) {
      const pts = model.pts(s);
      let prev = null;
      for (const p of pts) {
        const q = this.toImage(p, cssW, cssH);
        if (!q) { prev = null; continue; }
        let d = Math.hypot(q[0] - x, q[1] - y), pt = p;
        if (prev) {
          const [ax, ay] = prev.q, bx = q[0], by = q[1];
          const L2 = (bx - ax) ** 2 + (by - ay) ** 2;
          const t = L2 ? Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / L2)) : 0;
          const ds = Math.hypot(ax + (bx - ax) * t - x, ay + (by - ay) * t - y);
          if (ds < d) { d = ds; pt = [0, 1, 2].map((k) => prev.p[k] + (p[k] - prev.p[k]) * t); }
        }
        if (d < maxPx && (!best || d < best.d)) best = { id: s.id, d, point: pt };
        prev = { q, p };
      }
    }
    return best;
  }
}
