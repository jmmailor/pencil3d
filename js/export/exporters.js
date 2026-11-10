// Exporters: .3dm (Rhino, via rhino3dm.js), .obj, .dxf (R12), .fbx (ASCII 7.4).
// All work on a neutral "export scene" built by buildExportScene().
import { fitNurbs, tubeMesh, bbox, v3 } from '../geom.js';

export const UNITS = {
  mm: { label: 'Millimetres', perCm: 10, rhino: 'Millimeters', dxf: 4, fbx: 0.1 },
  cm: { label: 'Centimetres', perCm: 1, rhino: 'Centimeters', dxf: 5, fbx: 1 },
  m: { label: 'Metres', perCm: 0.01, rhino: 'Meters', dxf: 6, fbx: 100 },
  in: { label: 'Inches', perCm: 1 / 2.54, rhino: 'Inches', dxf: 1, fbx: 2.54 },
};

/**
 * opts: {units:'cm', origin:'tapped'|'bbox'|'sheet', geometry:'polyline'|'nurbs'|'both', tubes:bool, onlySelected:ids?}
 * model: {layers, strokes, origin}; getPts(stroke) returns processed polyline (cm, world).
 */
export function buildExportScene(model, getPts, opts) {
  const strokes = model.strokes.filter((s) => {
    const L = model.layers.find((l) => l.id === s.layer);
    return L && L.visible !== false && (!opts.onlyIds || opts.onlyIds.includes(s.id));
  });
  const all = strokes.map((s) => getPts(s));
  let origin = [0, 0, 0];
  const bb = bbox(all);
  if (opts.origin === 'tapped' && model.origin) origin = model.origin;
  else if (opts.origin === 'bbox' || (opts.origin === 'tapped' && !model.origin)) origin = bb ? bb.min : [0, 0, 0];
  const k = UNITS[opts.units || 'cm'].perCm;
  const tf = (p) => [(p[0] - origin[0]) * k, (p[1] - origin[1]) * k, (p[2] - origin[2]) * k];
  const usedLayers = model.layers.filter((l) => strokes.some((s) => s.layer === l.id));
  const layers = usedLayers.map((l) => ({ name: l.name, color: l.color }));
  const items = strokes.map((s, i) => {
    const pts = all[i].map(tf);
    const it = {
      name: s.name || `stroke_${i + 1}`,
      layer: usedLayers.findIndex((l) => l.id === s.layer),
      color: s.color,
      width: s.width * k,
      polyline: pts,
    };
    if (opts.geometry !== 'polyline') {
      // fit in cm (fit settings are in cm), then transform: B-splines are affine invariant
      const c = fitNurbs(all[i], { smooth: s.smooth ?? 0.5 });
      if (c) it.nurbs = Object.assign(c, { ctrl: c.ctrl.map(tf) });
    }
    if (opts.tubes) it.tube = tubeMesh(pts, (s.width * k) / 2, 12, true);
    return it;
  });
  return { layers, items, units: opts.units || 'cm', geometry: opts.geometry, origin };
}

export function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
const f6 = (x) => (Math.abs(x) < 5e-7 ? '0' : x.toFixed(6).replace(/\.?0+$/, ''));
const safe = (s) => String(s).replace(/[^A-Za-z0-9_\-]+/g, '_') || 'item';
const wantPoly = (S) => S.geometry !== 'nurbs';
const wantNurbs = (S, it) => S.geometry !== 'polyline' && it.nurbs;

// ------------------------------------------------------------------ OBJ
export function toOBJ(S, baseName) {
  const out = [`# Pencil3D export — units: ${S.units}, Z up`, `mtllib ${baseName}.mtl`];
  const mtl = ['# Pencil3D materials'];
  const mats = new Map();
  const matFor = (hex) => {
    if (!mats.has(hex)) {
      const name = 'c_' + hex.replace('#', '');
      mats.set(hex, name);
      const [r, g, b] = hexToRgb(hex).map((x) => (x / 255).toFixed(4));
      mtl.push(`newmtl ${name}`, `Kd ${r} ${g} ${b}`, `Ka 0 0 0`, `illum 1`, '');
    }
    return mats.get(hex);
  };
  let v = 0, vn = 0;
  for (const it of S.items) {
    const layer = safe(S.layers[it.layer]?.name || 'Default');
    out.push(`o ${safe(it.name)}`, `g ${layer}`, `usemtl ${matFor(it.color)}`);
    if (wantPoly(S)) {
      const base = v;
      for (const p of it.polyline) { out.push(`v ${f6(p[0])} ${f6(p[1])} ${f6(p[2])}`); v++; }
      out.push('l ' + it.polyline.map((_, i) => base + i + 1).join(' '));
    }
    if (wantNurbs(S, it)) {
      const c = it.nurbs, base = v;
      for (const p of c.ctrl) { out.push(`v ${f6(p[0])} ${f6(p[1])} ${f6(p[2])}`); v++; }
      const knots = c.knots || [];
      out.push('cstype bspline', `deg ${c.degree}`,
        `curv ${f6(knots[c.degree] ?? 0)} ${f6(knots[knots.length - 1 - c.degree] ?? 1)} ` + c.ctrl.map((_, i) => base + i + 1).join(' '),
        'parm u ' + knots.map(f6).join(' '), 'end');
    }
    if (it.tube) {
      const P = it.tube.positions, N = it.tube.normals, I = it.tube.indices;
      const base = v, nbase = vn;
      for (let i = 0; i < P.length; i += 3) { out.push(`v ${f6(P[i])} ${f6(P[i + 1])} ${f6(P[i + 2])}`); v++; }
      for (let i = 0; i < N.length; i += 3) { out.push(`vn ${f6(N[i])} ${f6(N[i + 1])} ${f6(N[i + 2])}`); vn++; }
      for (let i = 0; i < I.length; i += 3) {
        const a = I[i] + 1, b = I[i + 1] + 1, c = I[i + 2] + 1;
        out.push(`f ${base + a}//${nbase + a} ${base + b}//${nbase + b} ${base + c}//${nbase + c}`);
      }
    }
  }
  return { obj: out.join('\n') + '\n', mtl: mtl.join('\n') + '\n' };
}

// ------------------------------------------------------------------ DXF (R12, ASCII)
const ACI = [
  [1, 255, 0, 0], [2, 255, 255, 0], [3, 0, 255, 0], [4, 0, 255, 255], [5, 0, 0, 255], [6, 255, 0, 255],
  [7, 255, 255, 255], [8, 128, 128, 128], [9, 192, 192, 192], [30, 255, 127, 0], [40, 255, 191, 0],
  [140, 0, 127, 255], [200, 191, 0, 255], [250, 51, 51, 51], [210, 255, 0, 191], [100, 63, 255, 0], [20, 255, 63, 0],
];
function nearestAci(hex) {
  const [r, g, b] = hexToRgb(hex);
  let best = 7, bd = Infinity;
  for (const [i, R, G, B] of ACI) {
    const d = (r - R) ** 2 + (g - G) ** 2 + (b - B) ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  return best === 7 && r + g + b < 200 ? 250 : best; // dark colours → dark grey rather than white
}

export function toDXF(S) {
  const L = [];
  const g = (code, val) => L.push(String(code), String(val));
  const layerNames = S.layers.map((l) => safe(l.name).toUpperCase() || 'DEFAULT');
  g(0, 'SECTION'); g(2, 'HEADER');
  g(9, '$ACADVER'); g(1, 'AC1009');
  g(9, '$INSUNITS'); g(70, UNITS[S.units].dxf);
  g(0, 'ENDSEC');
  g(0, 'SECTION'); g(2, 'TABLES');
  g(0, 'TABLE'); g(2, 'LAYER'); g(70, layerNames.length + 1);
  g(0, 'LAYER'); g(2, '0'); g(70, 0); g(62, 7); g(6, 'CONTINUOUS');
  layerNames.forEach((n, i) => { g(0, 'LAYER'); g(2, n); g(70, 0); g(62, nearestAci(S.layers[i].color)); g(6, 'CONTINUOUS'); });
  g(0, 'ENDTAB');
  g(0, 'ENDSEC');
  g(0, 'SECTION'); g(2, 'ENTITIES');
  for (const it of S.items) {
    const layer = layerNames[it.layer] || '0';
    const col = nearestAci(it.color);
    // polyline (also used for NURBS in R12: densely sampled fitted curve is the same as the polyline)
    g(0, 'POLYLINE'); g(8, layer); g(62, col); g(66, 1); g(10, 0); g(20, 0); g(30, 0); g(70, 8);
    for (const p of it.polyline) { g(0, 'VERTEX'); g(8, layer); g(10, f6(p[0])); g(20, f6(p[1])); g(30, f6(p[2])); g(70, 32); }
    g(0, 'SEQEND'); g(8, layer);
    if (it.tube) {
      const P = it.tube.positions, I = it.tube.indices;
      for (let i = 0; i < I.length; i += 3) {
        const a = I[i] * 3, b = I[i + 1] * 3, c = I[i + 2] * 3;
        g(0, '3DFACE'); g(8, layer); g(62, col);
        g(10, f6(P[a])); g(20, f6(P[a + 1])); g(30, f6(P[a + 2]));
        g(11, f6(P[b])); g(21, f6(P[b + 1])); g(31, f6(P[b + 2]));
        g(12, f6(P[c])); g(22, f6(P[c + 1])); g(32, f6(P[c + 2]));
        g(13, f6(P[c])); g(23, f6(P[c + 1])); g(33, f6(P[c + 2]));
      }
    }
  }
  g(0, 'ENDSEC');
  g(0, 'EOF');
  return L.join('\r\n') + '\r\n';
}

// ------------------------------------------------------------------ FBX (ASCII 7.4)
export function toFBX(S) {
  let uid = 1000000;
  const id = () => ++uid;
  const objs = [], conns = [], models = [];
  const num = (x) => (Number.isInteger(x) ? String(x) : f6(x));
  const arr = (name, a, ind = '\t\t') => `${ind}${name}: *${a.length} {\n${ind}\ta: ${Array.from(a, num).join(',')}\n${ind}}`;
  const matIds = new Map();
  const material = (hex) => {
    if (matIds.has(hex)) return matIds.get(hex);
    const mid = id();
    const [r, g, b] = hexToRgb(hex).map((x) => (x / 255).toFixed(4));
    objs.push(`\tMaterial: ${mid}, "Material::c_${hex.replace('#', '')}", "" {
\t\tVersion: 102
\t\tShadingModel: "lambert"
\t\tMultiLayer: 0
\t\tProperties70:  {
\t\t\tP: "DiffuseColor", "Color", "", "A",${r},${g},${b}
\t\t\tP: "Diffuse", "Vector3D", "Vector", "",${r},${g},${b}
\t\t}
\t}`);
    matIds.set(hex, mid);
    return mid;
  };
  const addModel = (name, type, geomId, hex) => {
    const mid = id();
    const [r, g, b] = hexToRgb(hex).map((x) => (x / 255).toFixed(4));
    objs.push(`\tModel: ${mid}, "Model::${name}", "${type}" {
\t\tVersion: 232
\t\tProperties70:  {
\t\t\tP: "Color", "ColorRGB", "Color", "",${r},${g},${b}
\t\t}
\t\tShading: T
\t\tCulling: "CullingOff"
\t}`);
    conns.push(`\tC: "OO",${mid},0`, `\tC: "OO",${geomId},${mid}`);
    models.push(mid);
    return mid;
  };
  const nurbsGeom = (name, c) => {
    const gid = id();
    const pts = [];
    for (const p of c.ctrl) pts.push(p[0], p[1], p[2], 1);
    const knots = c.knots || (() => { // degree-1 fallback
      const k = [0]; for (let i = 0; i < c.ctrl.length; i++) k.push(i / (c.ctrl.length - 1)); k.push(1); return k;
    })();
    objs.push(`\tGeometry: ${gid}, "Geometry::${name}", "NurbsCurve" {
\t\tType: "NurbsCurve"
\t\tNurbsCurveVersion: 100
\t\tOrder: ${c.degree + 1}
\t\tDimension: 3
\t\tForm: "Open"
\t\tRational: 0
${arr('Points', pts)}
${arr('KnotVector', knots)}
\t}`);
    return gid;
  };
  S.items.forEach((it, i) => {
    const base = `${safe(S.layers[it.layer]?.name || 'Layer')}__${safe(it.name)}`;
    if (wantPoly(S)) {
      const k = [0];
      const n = it.polyline.length;
      for (let j = 0; j < n; j++) k.push(j / (n - 1));
      k.push(1);
      const gid = nurbsGeom(base + '_polyline', { degree: 1, ctrl: it.polyline, knots: k });
      addModel(base + '_polyline', 'NurbsCurve', gid, it.color);
    }
    if (wantNurbs(S, it)) {
      const gid = nurbsGeom(base + '_curve', it.nurbs);
      addModel(base + '_curve', 'NurbsCurve', gid, it.color);
    }
    if (it.tube) {
      const gid = id();
      const P = it.tube.positions, I = it.tube.indices, N = it.tube.normals;
      const pv = [];
      for (let j = 0; j < I.length; j += 3) pv.push(I[j], I[j + 1], -I[j + 2] - 1);
      const nrm = [];
      for (let j = 0; j < I.length; j++) { const q = I[j] * 3; nrm.push(N[q], N[q + 1], N[q + 2]); }
      objs.push(`\tGeometry: ${gid}, "Geometry::${base}_tube", "Mesh" {
${arr('Vertices', P)}
${arr('PolygonVertexIndex', pv)}
\t\tGeometryVersion: 124
\t\tLayerElementNormal: 0 {
\t\t\tVersion: 101
\t\t\tName: ""
\t\t\tMappingInformationType: "ByPolygonVertex"
\t\t\tReferenceInformationType: "Direct"
${arr('Normals', nrm, '\t\t\t')}
\t\t}
\t\tLayerElementMaterial: 0 {
\t\t\tVersion: 101
\t\t\tName: ""
\t\t\tMappingInformationType: "AllSame"
\t\t\tReferenceInformationType: "IndexToDirect"
\t\t\tMaterials: *1 {
\t\t\t\ta: 0
\t\t\t}
\t\t}
\t\tLayer: 0 {
\t\t\tVersion: 100
\t\t\tLayerElement:  {
\t\t\t\tType: "LayerElementNormal"
\t\t\t\tTypedIndex: 0
\t\t\t}
\t\t\tLayerElement:  {
\t\t\t\tType: "LayerElementMaterial"
\t\t\t\tTypedIndex: 0
\t\t\t}
\t\t}
\t}`);
      const mid = addModel(base + '_tube', 'Mesh', gid, it.color);
      conns.push(`\tC: "OO",${material(it.color)},${mid}`);
    }
  });
  const now = new Date();
  const unit = UNITS[S.units].fbx;
  const nGeom = objs.filter((o) => o.startsWith('\tGeometry')).length;
  const nMat = matIds.size;
  return `; FBX 7.4.0 project file
; Created by Pencil3D
; ----------------------------------------------------

FBXHeaderExtension:  {
\tFBXHeaderVersion: 1003
\tFBXVersion: 7400
\tCreationTimeStamp:  {
\t\tVersion: 1000
\t\tYear: ${now.getFullYear()}
\t\tMonth: ${now.getMonth() + 1}
\t\tDay: ${now.getDate()}
\t\tHour: ${now.getHours()}
\t\tMinute: ${now.getMinutes()}
\t\tSecond: ${now.getSeconds()}
\t\tMillisecond: 0
\t}
\tCreator: "Pencil3D"
}
GlobalSettings:  {
\tVersion: 1000
\tProperties70:  {
\t\tP: "UpAxis", "int", "Integer", "",2
\t\tP: "UpAxisSign", "int", "Integer", "",1
\t\tP: "FrontAxis", "int", "Integer", "",1
\t\tP: "FrontAxisSign", "int", "Integer", "",-1
\t\tP: "CoordAxis", "int", "Integer", "",0
\t\tP: "CoordAxisSign", "int", "Integer", "",1
\t\tP: "OriginalUpAxis", "int", "Integer", "",2
\t\tP: "OriginalUpAxisSign", "int", "Integer", "",1
\t\tP: "UnitScaleFactor", "double", "Number", "",${unit}
\t\tP: "OriginalUnitScaleFactor", "double", "Number", "",${unit}
\t}
}

Definitions:  {
\tVersion: 100
\tCount: ${1 + models.length + nGeom + nMat}
\tObjectType: "GlobalSettings" {
\t\tCount: 1
\t}
\tObjectType: "Model" {
\t\tCount: ${models.length}
\t}
\tObjectType: "Geometry" {
\t\tCount: ${nGeom}
\t}
\tObjectType: "Material" {
\t\tCount: ${nMat}
\t}
}

Objects:  {
${objs.join('\n')}
}

Connections:  {
${conns.join('\n')}
}
`;
}

// ------------------------------------------------------------------ Rhino .3dm
let rhinoPromise = null;
export function loadRhino() {
  if (!rhinoPromise) {
    rhinoPromise = import('../../vendor/rhino3dm.module.min.js').then((m) =>
      m.default({ locateFile: (f) => new URL('../../vendor/' + f, import.meta.url).href }));
  }
  return rhinoPromise;
}

export function to3dm(rh, S) {
  const file = new rh.File3dm();
  file.settings().modelUnitSystem = rh.UnitSystem[UNITS[S.units].rhino];
  file.settings().modelAbsoluteTolerance = 0.001 * (S.units === 'm' ? 0.01 : S.units === 'mm' ? 10 : 1);
  const layerIdx = S.layers.map((l) => {
    const L = new rh.Layer();
    L.name = l.name;
    const [r, g, b] = hexToRgb(l.color);
    L.color = { r, g, b, a: 255 };
    return file.layers().add(L);
  });
  for (const it of S.items) {
    const [r, g, b] = hexToRgb(it.color);
    const attrs = () => {
      const a = new rh.ObjectAttributes();
      a.layerIndex = layerIdx[it.layer] ?? 0;
      a.colorSource = rh.ObjectColorSource.ColorFromObject;
      a.objectColor = { r, g, b, a: 255 };
      a.name = it.name;
      return a;
    };
    if (wantPoly(S)) {
      const a = attrs();
      if (wantNurbs(S, it)) a.name = it.name + '_polyline';
      file.objects().addPolyline(it.polyline, a);
    }
    if (wantNurbs(S, it)) {
      const c = it.nurbs;
      let crv;
      if (c.knots) {
        crv = new rh.NurbsCurve(3, false, c.degree + 1, c.ctrl.length);
        c.ctrl.forEach((p, i) => crv.points().set(i, [p[0], p[1], p[2], 1]));
        const K = c.knots.slice(1, -1); // Rhino stores n+p-1 knots (no end "superfluous" knots)
        K.forEach((k, i) => crv.knots().set(i, k));
      }
      if (crv) {
        const a = attrs();
        if (wantPoly(S)) a.name = it.name + '_curve';
        file.objects().addCurve(crv, a);
      }
    }
    if (it.tube) {
      const m = new rh.Mesh();
      const P = it.tube.positions, I = it.tube.indices;
      for (let i = 0; i < P.length; i += 3) m.vertices().add(P[i], P[i + 1], P[i + 2]);
      for (let i = 0; i < I.length; i += 3) m.faces().addTriFace(I[i], I[i + 1], I[i + 2]);
      m.normals().computeNormals?.();
      m.compact?.();
      const a = attrs();
      a.name = it.name + '_tube';
      file.objects().addMesh(m, a);
    }
  }
  return file.toByteArray();
}

export function exportSummary(S) {
  const bb = bbox(S.items.map((i) => i.polyline));
  return { count: S.items.length, size: bb ? v3.sub(bb.max, bb.min) : [0, 0, 0] };
}
