/*
 * Marker layouts shared by the tracker (worker), the app and the print page.
 * Classic script: attaches to self.P3D so it can be used with importScripts().
 *
 * Units: centimetres.
 * World frame = desk board frame: origin at the centre of the sheet,
 * +X to the right, +Y away from you (towards the top of the printed sheet),
 * +Z up out of the desk  (same as Rhino's Top view).
 */
(function (G) {
  const P3D = (G.P3D = G.P3D || {});

  P3D.DICT_NAME = 'ARUCO_MIP_16h3';
  P3D.MARKER_CELLS = 6; // 4x4 data bits + 1 cell black border each side

  P3D.PAPERS = {
    a4: { name: 'A4', w: 29.7, h: 21.0 },
    letter: { name: 'US Letter', w: 27.94, h: 21.59 },
  };

  P3D.CUBE_ID_BASE = 40;

  /** Board: ring of markers around the edge of a landscape sheet. */
  P3D.boardLayout = function (paperKey) {
    const paper = P3D.PAPERS[paperKey] || P3D.PAPERS.a4;
    const W = paper.w, H = paper.h;
    const margin = 1.0, m = 3.0, gapMin = 0.8;
    const nx = Math.floor((W - 2 * margin + gapMin) / (m + gapMin));
    const ny = Math.floor((H - 2 * margin + gapMin) / (m + gapMin));
    const gx = (W - 2 * margin - nx * m) / (nx - 1);
    const gy = (H - 2 * margin - ny * m) / (ny - 1);
    const slots = []; // top-left of black square in sheet coords (cm, y down)
    for (let i = 0; i < nx; i++) slots.push([margin + i * (m + gx), margin]);
    for (let j = 1; j < ny - 1; j++) slots.push([W - margin - m, margin + j * (m + gy)]);
    for (let i = nx - 1; i >= 0; i--) slots.push([margin + i * (m + gx), H - margin - m]);
    for (let j = ny - 2; j >= 1; j--) slots.push([margin, margin + j * (m + gy)]);

    const toWorld = (xs, ys) => [xs - W / 2, H / 2 - ys, 0];
    const markers = slots.map(([x, y], id) => ({
      id,
      sheet: { x, y, size: m },
      // corner order: TL, TR, BR, BL of the printed marker image
      corners: [toWorld(x, y), toWorld(x + m, y), toWorld(x + m, y + m), toWorld(x, y + m)],
    }));
    const inner = { x0: margin + m + gx, y0: margin + m + gy, x1: W - margin - m - gx, y1: H - margin - m - gy };
    return { paper: paperKey, W, H, markerSize: m, markers, inner, byId: indexById(markers) };
  };

  /**
   * Pen cube of edge s. Printed as a cross-shaped net, folded with the print outside.
   * Faces: top (+Z), +X, +Y, -X, -Y carry markers; bottom (-Z) has the hole for the pencil.
   * Cube frame: origin at cube centre, pencil runs along -Z, tip at (0,0,-(s/2 + L)).
   */
  P3D.cubeLayout = function (s) {
    const h = s / 2;
    const m = s * 0.76; // black square size, leaves a white quiet zone
    // net coordinates: origin = centre of the top face, x right, y down (as printed)
    const faces = [
      { key: 'top', c: [0, 0], d: null },
      { key: '+X', c: [s, 0], d: [1, 0] },
      { key: '+Y', c: [0, -s], d: [0, -1] },
      { key: '-X', c: [-s, 0], d: [-1, 0] },
      { key: '-Y', c: [0, s], d: [0, 1] },
    ];
    const netToWorld = (face, xn, yn) => {
      let w = [xn, -yn]; // world XY if it stayed flat on the top plane
      if (!face.d) return [w[0], w[1], h];
      const D = [face.d[0], -face.d[1]];
      const a = w[0] * D[0] + w[1] * D[1]; // distance from cube centre along D (in the flat net)
      const perp = [w[0] - a * D[0], w[1] - a * D[1]];
      return [perp[0] + h * D[0], perp[1] + h * D[1], h - (a - h)];
    };
    const markers = faces.map((f, i) => {
      const [cx, cy] = f.c;
      const net = [
        [cx - m / 2, cy - m / 2], [cx + m / 2, cy - m / 2],
        [cx + m / 2, cy + m / 2], [cx - m / 2, cy + m / 2],
      ];
      return {
        id: P3D.CUBE_ID_BASE + i,
        face: f.key,
        net: { cx, cy, size: m },
        corners: net.map(([x, y]) => netToWorld(f, x, y)),
      };
    });
    return { size: s, markerSize: m, markers, byId: indexById(markers) };
  };

  function indexById(list) {
    const o = {};
    for (const mk of list) o[mk.id] = mk;
    return o;
  }

  /** Bits of a marker as a 2D array [row][col] of 0/1 (1 = white), 4x4 data area. */
  P3D.markerBits = function (id) {
    const dict = G.AR && G.AR.DICTIONARIES[P3D.DICT_NAME];
    if (!dict) throw new Error('ArUco dictionary not loaded');
    const code = dict.codeList[id];
    const bin = (typeof code === 'number' ? code : parseInt(code, 16)).toString(2).padStart(16, '0');
    const rows = [];
    for (let r = 0; r < 4; r++) {
      rows.push([]);
      for (let c = 0; c < 4; c++) rows[r].push(bin[r * 4 + c] === '1' ? 1 : 0);
    }
    return rows;
  };

  /** SVG fragment for a marker whose black square has top-left (x,y) and size `size`. */
  P3D.markerSVG = function (id, x, y, size) {
    const cell = size / P3D.MARKER_CELLS;
    const bits = P3D.markerBits(id);
    let s = `<rect x="${x}" y="${y}" width="${size}" height="${size}" fill="#000"/>`;
    for (let r = 0; r < 4; r++)
      for (let c = 0; c < 4; c++)
        if (bits[r][c])
          s += `<rect x="${x + (c + 1) * cell}" y="${y + (r + 1) * cell}" width="${cell * 1.002}" height="${cell * 1.002}" fill="#fff"/>`;
    return s;
  };

  /** Full printable board as SVG (units: cm). */
  P3D.boardSVG = function (paperKey, opts = {}) {
    const B = P3D.boardLayout(paperKey);
    const { W, H } = B;
    let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}cm" height="${H}cm" viewBox="0 0 ${W} ${H}">`;
    s += `<rect width="${W}" height="${H}" fill="#fff"/>`;
    for (const mk of B.markers) s += P3D.markerSVG(mk.id, mk.sheet.x, mk.sheet.y, mk.sheet.size);
    if (!opts.markersOnly) {
      const { x0, y0, x1, y1 } = B.inner;
      const cx = W / 2, cy = H / 2;
      // 1 cm grid in the inner area
      let g = '';
      for (let x = Math.ceil(x0 - cx) + cx; x <= x1; x += 1)
        g += `<line x1="${x}" y1="${y0}" x2="${x}" y2="${y1}"/>`;
      for (let y = Math.ceil(y0 - cy) + cy; y <= y1; y += 1)
        g += `<line x1="${x0}" y1="${y}" x2="${x1}" y2="${y}"/>`;
      s += `<g stroke="#d6d6d6" stroke-width="0.02">${g}</g>`;
      // axes
      s += `<g stroke-width="0.06" fill="none">
        <line x1="${cx}" y1="${cy}" x2="${cx + 4}" y2="${cy}" stroke="#d33"/>
        <line x1="${cx}" y1="${cy}" x2="${cx}" y2="${cy - 4}" stroke="#2a2"/>
        <circle cx="${cx}" cy="${cy}" r="0.25" stroke="#333"/></g>`;
      s += `<g font-family="Helvetica,Arial,sans-serif" fill="#555">
        <text x="${cx + 4.2}" y="${cy + 0.25}" font-size="0.7" fill="#d33">X</text>
        <text x="${cx - 0.25}" y="${cy - 4.3}" font-size="0.7" fill="#2a2">Y</text>
        <text x="${cx}" y="${y1 - 0.4}" font-size="0.5" text-anchor="middle">Pencil3D desk sheet · ${P3D.PAPERS[B.paper].name} · print at 100% (actual size) · this edge towards you</text>
        <text x="${x0 + 0.3}" y="${y0 + 0.8}" font-size="0.45">Check: black squares = exactly 3.0 cm</text>
      </g>`;
    }
    return s + '</svg>';
  };

  /** Printable cube net as SVG (units: cm). */
  P3D.cubeSVG = function (size) {
    const C = P3D.cubeLayout(size);
    const s = size, tab = Math.min(0.8, s * 0.3);
    // net bounds: x from -1.5s to 1.5s, y from -1.5s to 3.5s (bottom face below -Y)
    const ox = 1.5 * s + tab + 0.5, oy = 1.5 * s + tab + 0.5;
    const Wd = 3 * s + 2 * tab + 1, Hd = 5 * s + 2 * tab + 3.5;
    const sq = (cx, cy) => `<rect x="${ox + cx - s / 2}" y="${oy + cy - s / 2}" width="${s}" height="${s}"/>`;
    let out = `<svg xmlns="http://www.w3.org/2000/svg" width="${Wd}cm" height="${Hd}cm" viewBox="0 0 ${Wd} ${Hd}">`;
    out += `<rect width="${Wd}" height="${Hd}" fill="#fff"/>`;
    // glue tabs (trapezoids) on the free edges of the side faces
    const tabs = [];
    const T = (x1, y1, x2, y2, nx, ny) => {
      const k = tab * 0.35;
      const dx = (x2 - x1), dy = (y2 - y1), L = Math.hypot(dx, dy), ux = dx / L, uy = dy / L;
      tabs.push(`<polygon points="${ox + x1},${oy + y1} ${ox + x2},${oy + y2} ${ox + x2 + nx * tab - ux * k},${oy + y2 + ny * tab - uy * k} ${ox + x1 + nx * tab + ux * k},${oy + y1 + ny * tab + uy * k}"/>`);
    };
    const h = s / 2;
    // +X face (centre s,0): tabs on top and bottom edges
    T(h, -h, 3 * h, -h, 0, -1); T(h, h, 3 * h, h, 0, 1);
    // -X face
    T(-3 * h, -h, -h, -h, 0, -1); T(-3 * h, h, -h, h, 0, 1);
    // +Y face: tab on far edge (glues to bottom)
    T(-h, -3 * h, h, -3 * h, 0, -1);
    // +X/-X far edges glue to bottom
    T(3 * h, -h, 3 * h, h, 1, 0); T(-3 * h, -h, -3 * h, h, -1, 0);
    out += `<g fill="#eee" stroke="#999" stroke-width="0.02">${tabs.join('')}</g>`;
    out += `<g fill="#fff" stroke="#999" stroke-width="0.02" stroke-dasharray="0.15 0.1">`;
    out += sq(0, 0) + sq(s, 0) + sq(-s, 0) + sq(0, -s) + sq(0, s) + sq(0, 2 * s) + '</g>';
    for (const mk of C.markers) {
      const { cx, cy, size: m } = mk.net;
      out += P3D.markerSVG(mk.id, ox + cx - m / 2, oy + cy - m / 2, m);
    }
    // bottom face: pencil hole
    out += `<circle cx="${ox}" cy="${oy + 2 * s}" r="0.4" fill="none" stroke="#333" stroke-width="0.03"/>`;
    out += `<g font-family="Helvetica,Arial,sans-serif" fill="#555" font-size="0.3" text-anchor="middle">
      <text x="${ox}" y="${oy + 2 * s + 0.9}">bottom · pencil hole</text>
      <text x="${Wd / 2}" y="${Hd - 2.4}" font-size="0.4">Pencil cube ${s} cm · print at 100% · black squares = ${C.markerSize.toFixed(2)} cm</text>
      <text x="${Wd / 2}" y="${Hd - 1.8}" font-size="0.3">Cut out, fold along dashed lines with the print OUTSIDE, glue tabs inside.</text>
      <text x="${Wd / 2}" y="${Hd - 1.35}" font-size="0.3">Glue onto stiff card first for best results. Push the pencil's eraser end through the hole.</text>
      <text x="${Wd / 2}" y="${Hd - 0.9}" font-size="0.3">Keep the pencil straight along the cube's axis.</text></g>`;
    return out + '</svg>';
  };
})(typeof self !== 'undefined' ? self : globalThis);
