// Drawing model: layers, strokes, origin, undo/redo, autosave. Units: cm, world = desk sheet frame (Z up).
import { processStroke, polylineLength, bbox, v3 } from './geom.js';

export const PALETTE = ['#1c1c1e', '#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#00c7be',
  '#007aff', '#5856d6', '#af52de', '#ff2d55', '#8e8e93', '#ffffff'];

const AUTOSAVE_KEY = 'p3d.current';

export class Model extends EventTarget {
  constructor() {
    super();
    this.undoStack = [];
    this.redoStack = [];
    this.cache = new WeakMap();
    this.blank();
    this.load();
  }

  blank() {
    this.layers = [{ id: 'L1', name: 'Layer 1', color: '#007aff', visible: true }];
    this.activeLayer = 'L1';
    this.strokes = [];
    this.origin = null;
    this.nextId = 1;
  }

  state() {
    return { layers: this.layers, activeLayer: this.activeLayer, strokes: this.strokes, origin: this.origin, nextId: this.nextId };
  }
  serialize() { return JSON.stringify(this.state()); }
  apply(json) {
    const s = typeof json === 'string' ? JSON.parse(json) : json;
    this.layers = s.layers?.length ? s.layers : [{ id: 'L1', name: 'Layer 1', color: '#007aff', visible: true }];
    this.activeLayer = this.layers.some((l) => l.id === s.activeLayer) ? s.activeLayer : this.layers[0].id;
    this.strokes = s.strokes || [];
    this.origin = s.origin || null;
    this.nextId = s.nextId || this.strokes.reduce((m, x) => Math.max(m, x.id + 1), 1);
  }

  /** Record an undo step, then run fn which mutates the model. */
  commit(fn) {
    this.undoStack.push(this.serialize());
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
    fn();
    this.changed();
  }
  /** Start a continuous edit (e.g. dragging): snapshot once, mutate freely, call changed(). */
  beginEdit() { this.undoStack.push(this.serialize()); this.redoStack = []; }
  undo() {
    if (!this.undoStack.length) return false;
    this.redoStack.push(this.serialize());
    this.apply(this.undoStack.pop());
    this.changed();
    return true;
  }
  redo() {
    if (!this.redoStack.length) return false;
    this.undoStack.push(this.serialize());
    this.apply(this.redoStack.pop());
    this.changed();
    return true;
  }
  changed() {
    this.dispatchEvent(new Event('change'));
    clearTimeout(this._saveT);
    this._saveT = setTimeout(() => this.save(), 400);
  }
  save() { try { localStorage.setItem(AUTOSAVE_KEY, this.serialize()); } catch (e) { /* storage full */ } }
  load() { try { const s = localStorage.getItem(AUTOSAVE_KEY); if (s) this.apply(s); } catch (e) { this.blank(); } }

  // ----- strokes
  pts(s) {
    const key = `${s.raw.length}|${s.smooth}|${s.straight}|${s.rev || 0}`;
    const c = this.cache.get(s);
    if (c && c.key === key) return c.pts;
    const pts = processStroke(s.raw, { smooth: s.smooth, straighten: s.straight });
    this.cache.set(s, { key, pts });
    return pts;
  }
  layerOf(s) { return this.layers.find((l) => l.id === s.layer); }
  visibleStrokes() { return this.strokes.filter((s) => this.layerOf(s)?.visible !== false); }
  byIds(ids) { const set = new Set(ids); return this.strokes.filter((s) => set.has(s.id)); }

  addStroke(props) {
    const s = Object.assign({ id: this.nextId++, layer: this.activeLayer, name: '' }, props);
    s.name = s.name || `stroke_${s.id}`;
    this.strokes.push(s);
    return s;
  }
  deleteStrokes(ids) { const set = new Set(ids); this.strokes = this.strokes.filter((s) => !set.has(s.id)); }
  translate(ids, d) {
    for (const s of this.byIds(ids)) {
      s.raw = s.raw.map((p) => [p[0] + d[0], p[1] + d[1], p[2] + d[2]]);
      s.rev = (s.rev || 0) + 1;
    }
  }
  duplicate(ids, offset = [1, 1, 0]) {
    const out = [];
    for (const s of this.byIds(ids)) {
      const { id, name, rev, ...rest } = s;
      const c = this.addStroke({ ...rest, raw: s.raw.map((p) => v3.add(p, offset)) });
      out.push(c.id);
    }
    return out;
  }
  stats(ids) {
    const list = this.byIds(ids);
    const pts = list.map((s) => this.pts(s));
    const len = pts.reduce((a, p) => a + polylineLength(p), 0);
    return { count: list.length, length: len, bbox: bbox(pts) };
  }

  // ----- layers
  addLayer(name) {
    let i = this.layers.length + 1;
    let id;
    do { id = 'L' + Math.random().toString(36).slice(2, 8); } while (this.layers.some((l) => l.id === id));
    const colors = PALETTE.slice(1);
    this.layers.push({ id, name: name || `Layer ${i}`, color: colors[(i - 1) % colors.length], visible: true });
    this.activeLayer = id;
    return id;
  }
  deleteLayer(id) {
    if (this.layers.length <= 1) return;
    this.strokes = this.strokes.filter((s) => s.layer !== id);
    this.layers = this.layers.filter((l) => l.id !== id);
    if (this.activeLayer === id) this.activeLayer = this.layers[0].id;
  }
}

// ----- saved drawings (IndexedDB, on-device only)
const DB = 'pencil3d', STORE = 'sessions';
function db() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function tx(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => res(out && out.result !== undefined ? out.result : out);
    t.onerror = () => rej(t.error);
  });
}
export const Sessions = {
  list: () => tx('readonly', (s) => s.getAll()).then((a) => (a || []).sort((x, y) => y.date - x.date)),
  save: (name, data) => tx('readwrite', (s) => s.put({ id: name.toLowerCase(), name, date: Date.now(), data })),
  remove: (id) => tx('readwrite', (s) => s.delete(id)),
};
