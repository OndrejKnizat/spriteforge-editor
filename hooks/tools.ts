// The Edit studio's pixel operations (app/edit.html, app/engine/tools.js, app/sf-store.js), ported
// to the pixel editor pane's data: a cel is a row-major array of palette indexes, -1 transparent,
// on a w x h canvas. Each function says which site function it follows; where the site works on its
// square backing grid, these work on the visible w x h.

export type Cel = number[]
export type Pt = [number, number]

// ── colour maths (edit.html hexRgb / rgbHex / shiftHex / lum, setPkFromHex / hsvHex) ──
export const hexRgb = (hx: string): [number, number, number] => {
  const n = parseInt(hx.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
export const rgbHex = (r: number, g: number, b: number) =>
  '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')
export const shiftHex = (hx: string, amt: number) => {
  const [r, g, b] = hexRgb(hx), f = 1 + amt
  return rgbHex(r * f, g * f, b * f)
}
export const lum = (hx: string) => {
  const [r, g, b] = hexRgb(hx)
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255
}
export function hexHsv(hx: string): { h: number; s: number; v: number } {
  const [r, g, b] = hexRgb(hx), mx = Math.max(r, g, b), mn = Math.min(r, g, b)
  let h = 0
  if (mx !== mn) {
    if (mx === r) h = 60 * (((g - b) / (mx - mn)) % 6)
    else if (mx === g) h = 60 * ((b - r) / (mx - mn) + 2)
    else h = 60 * ((r - g) / (mx - mn) + 4)
  }
  if (h < 0) h += 360
  return { h, s: mx ? (mx - mn) / mx : 0, v: mx / 255 }
}
export function hsvHex(h: number, s: number, v: number): string {
  h = ((h % 360) + 360) % 360
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]
  return rgbHex((r + m) * 255, (g + m) * 255, (b + m) * 255)
}
// A colour mixed toward another by t (0 = a, 1 = b): layer opacity and onion ghosts on screen.
export function mixHex(a: string, b: string, t: number): string {
  const p = hexRgb(a), q = hexRgb(b)
  return rgbHex(p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t)
}

// The classic DawnBringer 32 (edit.html loadDB32).
export const DB32 = ['#000000', '#222034', '#45283c', '#663931', '#8f563b', '#df7126', '#d9a066', '#eec39a', '#fbf236', '#99e550',
  '#6abe30', '#37946e', '#4b692f', '#524b24', '#323c39', '#3f3f74', '#306082', '#5b6ee1', '#639bff', '#5fcde4', '#cbdbfc', '#ffffff',
  '#9badb7', '#847e87', '#696a6a', '#595652', '#764462', '#ac3232', '#d95763', '#d77bba', '#8f974a', '#8a6f30']

// Merge the nearest pair of colours by averaging until n are left (sf-store.js reducePalette);
// `map` sends each old index to its new one.
export function reducePalette(palette: string[], n: number): { palette: string[]; map: number[] } {
  const cols = palette.map(hexRgb), map = palette.map((_, i) => i), alive = palette.map(() => true)
  let live = palette.length
  while (live > n) {
    let bi = -1, bj = -1, bd = 1e18
    for (let i = 0; i < cols.length; i++) {
      if (!alive[i]) continue
      for (let j = i + 1; j < cols.length; j++) {
        if (!alive[j]) continue
        const d = (cols[i]![0] - cols[j]![0]) ** 2 + (cols[i]![1] - cols[j]![1]) ** 2 + (cols[i]![2] - cols[j]![2]) ** 2
        if (d < bd) { bd = d; bi = i; bj = j }
      }
    }
    if (bi < 0) break
    cols[bi] = [(cols[bi]![0] + cols[bj]![0]) / 2, (cols[bi]![1] + cols[bj]![1]) / 2, (cols[bi]![2] + cols[bj]![2]) / 2]
    alive[bj] = false
    for (let k = 0; k < map.length; k++) if (map[k] === bj) map[k] = bi
    live--
  }
  const idx: number[] = [], out: string[] = []
  cols.forEach((c, i) => { if (alive[i]) { idx[i] = out.length; out.push(rgbHex(c[0], c[1], c[2])) } })
  return { palette: out, map: map.map((m) => idx[m]!) }
}

// ── brushes and shapes ──
// A brush of n pixels, round past 2 (edit.html brushCells).
export function brushCells(cx: number, cy: number, n: number, round: boolean): Pt[] {
  const out: Pt[] = [], r = (n - 1) / 2
  for (let dy = 0; dy < n; dy++) for (let dx = 0; dx < n; dx++) {
    if (round && n > 2 && (dx - r) ** 2 + (dy - r) ** 2 > (n / 2) * (n / 2)) continue
    out.push([cx + dx - Math.floor(r), cy + dy - Math.floor(r)])
  }
  return out
}

// Bresenham, in the site's form (edit.html lineCells).
export function lineCells(x0: number, y0: number, x1: number, y1: number): Pt[] {
  const pts: Pt[] = []
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1
  let err = dx - dy
  for (;;) {
    pts.push([x0, y0])
    if (x0 === x1 && y0 === y1) break
    const e2 = 2 * err
    if (e2 > -dy) { err -= dy; x0 += sx }
    if (e2 < dx) { err += dx; y0 += sy }
  }
  return pts
}

// Line, rectangle or ellipse from corner to corner (edit.html shapeCells); an outline is the
// cells with a side outside.
export function shapeCells(tool: 'line' | 'rect' | 'ellipse', filled: boolean, x0: number, y0: number, x1: number, y1: number): Pt[] {
  if (tool === 'line') return lineCells(x0, y0, x1, y1)
  const ax = Math.min(x0, x1), bx = Math.max(x0, x1), ay = Math.min(y0, y1), by = Math.max(y0, y1), out: Pt[] = []
  if (tool === 'rect') {
    for (let y = ay; y <= by; y++) for (let x = ax; x <= bx; x++) if (filled || y === ay || y === by || x === ax || x === bx) out.push([x, y])
    return out
  }
  const ecx = (ax + bx) / 2, ecy = (ay + by) / 2, rx = Math.max(0.5, (bx - ax) / 2), ry = Math.max(0.5, (by - ay) / 2)
  const inside = (x: number, y: number) => ((x - ecx) / (rx + 0.5)) ** 2 + ((y - ecy) / (ry + 0.5)) ** 2 <= 1
  for (let y = ay; y <= by; y++) for (let x = ax; x <= bx; x++) {
    if (!inside(x, y)) continue
    if (filled || !inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1)) out.push([x, y])
  }
  return out
}

// ── regions ──
// 4-connected region of one index (edit.html wandAt / fill).
export function region(cel: Cel, w: number, h: number, x: number, y: number): number[] {
  const t = cel[y * w + x], seen = new Set([y * w + x]), stack = [y * w + x], out: number[] = []
  while (stack.length) {
    const i = stack.pop()!, px = i % w, py = (i - px) / w
    out.push(i)
    for (const [nx, ny] of [[px + 1, py], [px - 1, py], [px, py + 1], [px, py - 1]] as Pt[]) {
      const k = ny * w + nx
      if (nx >= 0 && ny >= 0 && nx < w && ny < h && !seen.has(k) && cel[k] === t) { seen.add(k); stack.push(k) }
    }
  }
  return out
}

// The cells a freehand lasso path encloses, the path included (edit.html lassoCommit).
export function lassoCells(pts: Pt[], w: number, h: number): number[] {
  if (pts.length < 3) return []
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y) }
  const inside = (px: number, py: number) => {
    let c = false
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i]![0] + 0.5, yi = pts[i]![1] + 0.5, xj = pts[j]![0] + 0.5, yj = pts[j]![1] + 0.5
      if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) c = !c
    }
    return c
  }
  const seen = new Set<number>()
  for (const [x, y] of pts) if (x >= 0 && y >= 0 && x < w && y < h) seen.add(y * w + x)
  for (let y = Math.max(0, y0); y <= Math.min(h - 1, y1); y++) for (let x = Math.max(0, x0); x <= Math.min(w - 1, x1); x++) {
    if (inside(x + 0.5, y + 0.5)) seen.add(y * w + x)
  }
  return [...seen]
}

// Where a floating w x h block lands rotated by `ang` around pivot (px, py), its top-left at
// (ox, oy): calls put(x, y, i, j) for each canvas cell it covers and the block cell that fills it
// (edit.html rotMap: nearest neighbour, sampled per destination cell).
export function rotMap(fw: number, fh: number, ox: number, oy: number, pvx: number, pvy: number, ang: number, w: number, h: number,
  put: (x: number, y: number, i: number, j: number) => void) {
  const cos = Math.cos(ang), sin = Math.sin(ang)
  const corners = ([[ox, oy], [ox + fw, oy], [ox, oy + fh], [ox + fw, oy + fh]] as Pt[])
    .map(([x, y]) => { const dx = x - pvx, dy = y - pvy; return [pvx + dx * cos - dy * sin, pvy + dx * sin + dy * cos] as Pt })
  const x0 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[0]))) - 1), y0 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[1]))) - 1)
  const x1 = Math.min(w - 1, Math.ceil(Math.max(...corners.map((c) => c[0]))) + 1), y1 = Math.min(h - 1, Math.ceil(Math.max(...corners.map((c) => c[1]))) + 1)
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const dx = x + 0.5 - pvx, dy = y + 0.5 - pvy
    const i = Math.floor(pvx + dx * cos + dy * sin) - ox, j = Math.floor(pvy - dx * sin + dy * cos) - oy
    if (i >= 0 && j >= 0 && i < fw && j < fh) put(x, y, i, j)
  }
}

// ── whole-cel operations ──
// 1px outline around the opaque pixels (tools.js toolOutline): 'tinted' is a deep, slightly cool
// shade of the most-used colour (darkness 0-100), reusing a near colour if the palette has one.
export function outline(cel: Cel, w: number, h: number, palette: string[], mode: 'tinted' | 'black' | 'white', darkness: number): { cel: Cel; palette: string[] } {
  const pal = palette.slice(), dist = (a: number[], b: number[]) => (a[0]! - b[0]!) ** 2 + (a[1]! - b[1]!) ** 2 + (a[2]! - b[2]!) ** 2
  let target: [number, number, number] | null = null, near = 18
  if (mode === 'black' || mode === 'white') target = mode === 'white' ? [255, 255, 255] : [0, 0, 0]
  else {
    const count = new Map<number, number>()
    for (const v of cel) if (v >= 0) count.set(v, (count.get(v) || 0) + 1)
    let body = -1, most = -1
    for (const [v, c] of count) if (c > most) { most = c; body = v }
    if (body < 0) return { cel, palette }
    const [hh, s, l] = rgbToHsl(hexRgb(pal[body]!)), dk = Math.max(0, Math.min(100, darkness)) / 100
    let d = 0.6 - hh
    if (d > 0.5) d -= 1
    if (d < -0.5) d += 1
    target = hslToRgb([(hh + d * 0.15 + 1) % 1, Math.min(1, s + 0.1), Math.max(0.03, l * (1 - dk))])
    near = 60
  }
  let k = pal.findIndex((c) => dist(hexRgb(c), target!) < (mode === 'tinted' ? near : near + 1))
  if (k < 0) { pal.push(rgbHex(...target)); k = pal.length - 1 }
  const out = cel.slice()
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (cel[y * w + x]! >= 0) continue
    if ((x > 0 && cel[y * w + x - 1]! >= 0) || (x < w - 1 && cel[y * w + x + 1]! >= 0) || (y > 0 && cel[(y - 1) * w + x]! >= 0) || (y < h - 1 && cel[(y + 1) * w + x]! >= 0)) out[y * w + x] = k
  }
  return { cel: out, palette: pal }
}
function rgbToHsl([r, g, b]: number[]): [number, number, number] {
  r! /= 255; g! /= 255; b! /= 255
  const mx = Math.max(r!, g!, b!), mn = Math.min(r!, g!, b!), l = (mx + mn) / 2
  if (mx === mn) return [0, 0, l]
  const d = mx - mn, s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn)
  const h = mx === r ? (g! - b!) / d + (g! < b! ? 6 : 0) : mx === g ? (b! - r!) / d + 2 : (r! - g!) / d + 4
  return [h / 6, s, l]
}
function hslToRgb([h, s, l]: number[]): [number, number, number] {
  if (s === 0) { const v = Math.round(l! * 255); return [v, v, v] }
  const q = l! < 0.5 ? l! * (1 + s!) : l! + s! - l! * s!, p = 2 * l! - q
  const f = (t: number) => { if (t < 0) t += 1; if (t > 1) t -= 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p }
  return [Math.round(f(h! + 1 / 3) * 255), Math.round(f(h!) * 255), Math.round(f(h! - 1 / 3) * 255)]
}

// Peel the dark ring around the silhouette (tools.js toolStripOutline): colours living mostly on
// the edge of the outside region and darker than the body, ring by ring.
export function stripOutline(cel: Cel, w: number, h: number, palette: string[]): Cel {
  const g = cel.slice()
  const outside = () => {
    const out = new Array<boolean>(w * h).fill(false), st: Pt[] = []
    for (let x = 0; x < w; x++) { st.push([x, 0], [x, h - 1]) }
    for (let y = 0; y < h; y++) { st.push([0, y], [w - 1, y]) }
    while (st.length) {
      const [x, y] = st.pop()!
      if (x < 0 || y < 0 || x >= w || y >= h || out[y * w + x] || g[y * w + x]! >= 0) continue
      out[y * w + x] = true
      st.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1])
    }
    return out
  }
  const isOut = (o: boolean[], x: number, y: number) => x < 0 || y < 0 || x >= w || y >= h || o[y * w + x]!
  const touches = (o: boolean[], x: number, y: number) => isOut(o, x - 1, y) || isOut(o, x + 1, y) || isOut(o, x, y - 1) || isOut(o, x, y + 1)
  let o = outside()
  const edge = new Map<number, number>(), total = new Map<number, number>()
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const k = g[y * w + x]!
    if (k < 0) continue
    total.set(k, (total.get(k) || 0) + 1)
    if (touches(o, x, y)) edge.set(k, (edge.get(k) || 0) + 1)
  }
  const colors = [...total.keys()]
  if (!colors.length) return g
  const ratio = (k: number) => (edge.get(k) || 0) / total.get(k)!
  let dom = -1, dm = -1
  for (const k of colors) if ((edge.get(k) || 0) > dm) { dm = edge.get(k) || 0; dom = k }
  if (dm <= 0 || ratio(dom) < 0.5) return g
  const lumOf = (k: number) => { const c = hexRgb(palette[k] || '#000000'); return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2] }
  const ring = new Set(colors.filter((k) => ratio(k) >= 0.5)), body = colors.filter((k) => !ring.has(k))
  if (!body.length) return g
  const bodyLum = body.reduce((s, k) => s + lumOf(k), 0) / body.length
  for (const k of [...ring]) if (lumOf(k) >= bodyLum) ring.delete(k)
  if (!ring.size) return g
  for (let guard = 0; guard < Math.max(w, h); guard++) {
    const rm: number[] = []
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const k = g[y * w + x]!; if (k >= 0 && ring.has(k) && touches(o, x, y)) rm.push(y * w + x) }
    if (!rm.length) break
    for (const i of rm) g[i] = -1
    o = outside()
  }
  return g
}

// Flood-clear the commonest border colour inward from the edges (edit.html rmBg).
export function removeBackground(cel: Cel, w: number, h: number): { cel: Cel; n: number } {
  const count = new Map<number, number>()
  const tally = (v: number) => { if (v >= 0) count.set(v, (count.get(v) || 0) + 1) }
  for (let x = 0; x < w; x++) { tally(cel[x]!); tally(cel[(h - 1) * w + x]!) }
  for (let y = 0; y < h; y++) { tally(cel[y * w]!); tally(cel[y * w + w - 1]!) }
  let target = -1, most = 0
  for (const [v, c] of count) if (c > most) { most = c; target = v }
  if (target < 0) return { cel, n: 0 }
  const g = cel.slice(), seen = new Set<number>(), st: number[] = []
  const seed = (x: number, y: number) => { const k = y * w + x; if (g[k] === target && !seen.has(k)) { seen.add(k); st.push(k) } }
  for (let x = 0; x < w; x++) { seed(x, 0); seed(x, h - 1) }
  for (let y = 0; y < h; y++) { seed(0, y); seed(w - 1, y) }
  let n = 0
  while (st.length) {
    const k = st.pop()!, x = k % w, y = (k - x) / w
    g[k] = -1
    n++
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]] as Pt[]) if (nx >= 0 && ny >= 0 && nx < w && ny < h) seed(nx, ny)
  }
  return { cel: g, n }
}

// Wrap by half the canvas both ways (edit.html offsetHalf).
export function offsetHalf(cel: Cel, w: number, h: number): Cel {
  const out = new Array<number>(w * h), dx = Math.floor(w / 2), dy = Math.floor(h / 2)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[((y + dy) % h) * w + ((x + dx) % w)] = cel[y * w + x]!
  return out
}

// Fill transparent pixels whose four neighbours are all opaque (edit.html tidy).
export function tidy(cel: Cel, w: number, h: number): { cel: Cel; n: number } {
  const out = cel.slice()
  let n = 0
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (cel[y * w + x]! >= 0) continue
    const nb = ([[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]] as Pt[]).map(([a, b]) => (a >= 0 && b >= 0 && a < w && b < h ? cel[b * w + a]! : -1))
    if (nb.every((v) => v >= 0)) { out[y * w + x] = nb[0]!; n++ }
  }
  return { cel: out, n }
}

// Flip or turn a block (edit.html flipH / flipV / rotate: 90° clockwise, square blocks only).
export function flipBlock(px: Cel, w: number, h: number, how: 'h' | 'v' | 'rot'): Cel {
  const out = new Array<number>(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    out[y * w + x] = how === 'h' ? px[y * w + (w - 1 - x)]! : how === 'v' ? px[(h - 1 - y) * w + x]! : px[(h - 1 - x) * w + y]!
  }
  return out
}

// Nearest-neighbour resample of a w x h block to nw x nh (edit.html resizeCanvas / dropScaled).
export function resample(px: Cel, w: number, h: number, nw: number, nh: number): Cel {
  const out = new Array<number>(nw * nh)
  for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) out[y * nw + x] = px[Math.floor((y * h) / nh) * w + Math.floor((x * w) / nw)]!
  return out
}

// A w x h cel placed on an nw x nh canvas at (ox, oy), clipped (edit.html applyCanvasResize).
export function placeCel(px: Cel, w: number, h: number, nw: number, nh: number, ox: number, oy: number): Cel {
  const out = new Array<number>(nw * nh).fill(-1)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const nx = x + ox, ny = y + oy
    if (nx >= 0 && ny >= 0 && nx < nw && ny < nh) out[ny * nw + nx] = px[y * w + x]!
  }
  return out
}
