// Wang (dual-grid) autotiles as SpriteForge makes them (app/engine/wang.js, which the server's
// generator runs too): 16 tiles on one palette, tile `mask` drawn where the map cells at its
// corners are painted, NW = 1, NE = 2, SW = 4, SE = 8. Tile 15 is the solid base texture; every
// other tile keeps the base's pixels toward its painted corners and drops them toward the rest,
// along straight dithered edges. Tiles are index grids, row-major, -1 transparent.

export const TILES = 16
export const BASE = 15
// The quadrant glyph that pictures each mask's painted corners.
export const QUADS = [' ', '▘', '▝', '▀', '▖', '▌', '▞', '▛', '▗', '▚', '▐', '▜', '▄', '▙', '▟', '█']
export const CORNERS = ['NW', 'NE', 'SW', 'SE']

// The engine's hash, verbatim, quirks and all (its `>>` keeps the sign bit, so it never reaches
// 0.5): the derived tiles match SpriteForge's only if it does.
export function hash(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) ^ 0x5bf03635
  h = (h ^ (h >> 13)) * 1274126177
  return ((h ^ (h >> 16)) >>> 0) / 4294967296
}

// Whether tile `mask` keeps the base pixel at (x, y): the corner field's signed distance to its
// 0.5 line, kept 1.5 px inside, dropped 1.5 px outside, hash-dithered between. `smooth` is the
// radial falloff sets made before 2026-07-29 used, kept only to recognise their tiles as derived.
function keeps(mask: number, x: number, y: number, T: number, smooth: boolean): boolean {
  if (mask === BASE) return true
  const nw = mask & 1, ne = (mask >> 1) & 1, sw = (mask >> 2) & 1, se = (mask >> 3) & 1
  if (smooth) {
    const half = T / 2, top = y < half, left = x < half
    if ((top && left && nw) || (top && !left && ne) || (!top && left && sw) || (!top && !left && se)) return true
    const a = 255 * Math.max(0, 1 - Math.min(1, Math.hypot((x - half) / half, (y - half) / half)))
    return Math.round(a) >= 128
  }
  const field = (u: number, v: number) => nw * (1 - u) * (1 - v) + ne * u * (1 - v) + sw * (1 - u) * v + se * u * v
  const du = 0.5 / T, u = (x + 0.5) / T, v = (y + 0.5) / T
  const gx = (field(u + du, v) - field(u - du, v)) / (2 * du) / T
  const gy = (field(u, v + du) - field(u, v - du)) / (2 * du) / T
  const d = (field(u, v) - 0.5) / Math.max(1e-4, Math.hypot(gx, gy))
  return d > 1.5 ? true : d < -1.5 ? false : hash(x, y) < 0.5 + d / 3
}

// The 16 tiles of a T x T base texture.
export function deriveTiles(base: number[], T: number, smooth = false): number[][] {
  return Array.from({ length: TILES }, (_, m) => base.map((v, i) => (v >= 0 && keeps(m, i % T, Math.floor(i / T), T, smooth) ? v : -1)))
}

const sameColours = (a: number[], b: number[], palette: string[]) =>
  a.length === b.length && a.every((v, i) => (v < 0 ? null : palette[v]) === (b[i]! < 0 ? null : palette[b[i]!]))

// The tiles after the base texture changes: each tile still matching a derive of the old base
// (by either falloff) is derived again from the new one; a tile that doesn't was drawn by hand
// and stays as it is.
export function rederive(tiles: number[][], palette: string[], base: number[], T: number): { tiles: number[][]; kept: number } {
  const old = tiles[BASE]!
  const baselines = [deriveTiles(old, T), deriveTiles(old, T, true)]
  const fresh = deriveTiles(base, T)
  let kept = 0
  const out = fresh.map((f, c) => {
    if (c === BASE || baselines.some((b) => sameColours(tiles[c]!, b[c]!, palette))) return f
    kept++
    return tiles[c]!
  })
  return { tiles: out, kept }
}

// Dual-grid placement: one tile per cell vertex, its mask from the four cells touching it;
// tile `mask` is drawn at pixel (vx*T - T/2, vy*T - T/2). Mask 0 (no cell painted) is skipped.
export function wangPlacements(has: (x: number, y: number) => boolean, minX: number, minY: number, maxX: number, maxY: number) {
  const out: { vx: number; vy: number; mask: number }[] = []
  for (let vy = minY; vy <= maxY + 1; vy++) for (let vx = minX; vx <= maxX + 1; vx++) {
    const mask = (has(vx - 1, vy - 1) ? 1 : 0) | (has(vx, vy - 1) ? 2 : 0) | (has(vx - 1, vy) ? 4 : 0) | (has(vx, vy) ? 8 : 0)
    if (mask) out.push({ vx, vy, mask })
  }
  return out
}

// A grassy base texture for a new set: four greens in clumps of 2x2 with a little speckle, about
// a fifth each of the darkest and lightest, from an even 32-bit hash.
export const GRASS = ['#2f6b3a', '#3f8a45', '#5aa64f', '#7cc35e']
function noise(x: number, y: number): number {
  let n = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0
  n = Math.imul(n ^ (n >>> 13), 1274126177)
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296
}
export function grassBase(T: number): number[] {
  return Array.from({ length: T * T }, (_, i) => {
    const x = i % T, y = Math.floor(i / T), t = noise((x >> 1) + 7, (y >> 1) + 3) * 0.8 + noise(x, y) * 0.2
    return t < 0.25 ? 0 : t < 0.5 ? 1 : t < 0.75 ? 2 : 3
  })
}

// The two other ways SpriteForge previews a Wang set (app/engine/wang.js), on palette-index
// pictures: -1 is transparent, and -(i + 2) is palette colour i in shade (a wall's front face).
export const shadedIndex = (i: number) => -(i + 2)
export const SHADE = 0.55

// Isometric: the flat map reprojected onto a 2:1 diamond, (W + H) x ceil((W + H) / 2), each output
// pixel taken from the flat pixel under it (projectIsoBuffer).
export function projectIso(src: number[], W: number, H: number): { w: number; h: number; px: number[] } {
  const OW = W + H, OH = Math.max(1, Math.ceil((W + H) / 2)), px = new Array<number>(OW * OH).fill(-1)
  for (let sy = 0; sy < OH; sy++) for (let sx = 0; sx < OW; sx++) {
    const half = (sx - H) / 2, fx = Math.floor(half + sy), fy = Math.floor(sy - half)
    if (fx >= 0 && fy >= 0 && fx < W && fy < H) px[sy * OW + sx] = src[fy * W + fx]!
  }
  return { w: OW, h: OH, px }
}

// Wall: each painted cell a band of the base texture inset from its square, reaching into painted
// neighbours so runs join, with a shaded front face `height` px deep under every open south edge
// (buildWallOverlayBuffer; inset and height from the set's thickness 0.56 and height 0.33).
export function wallOverlay(has: (x: number, y: number) => boolean, cols: number, rows: number, base: number[], T: number) {
  const inset = Math.max(0, Math.min((T >> 1) - 1, Math.round(((1 - 0.56) / 2) * T))), height = Math.round(0.33 * T)
  const W = cols * T, H = rows * T + height, px = new Array<number>(W * H).fill(-1)
  const tex = (x: number, y: number) => base[(((y % T) + T) % T) * T + (((x % T) + T) % T)]!
  const put = (x: number, y: number, v: number) => { if (v !== -1 && x >= 0 && y >= 0 && x < W && y < H) px[y * W + x] = v }
  for (let cy = 0; cy < rows; cy++) for (let cx = 0; cx < cols; cx++) {
    if (!has(cx, cy)) continue
    const n = cy > 0 && has(cx, cy - 1), s = cy < rows - 1 && has(cx, cy + 1), e = cx < cols - 1 && has(cx + 1, cy), w = cx > 0 && has(cx - 1, cy)
    const x0 = w ? 0 : inset, x1 = e ? T : T - inset, y0 = n ? 0 : inset, y1 = s ? T : T - inset, ox = cx * T, oy = cy * T
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) put(ox + x, oy + y, tex(ox + x, oy + y))
    if (!s) for (let x = x0; x < x1; x++) for (let k = 0; k < height; k++) {
      const v = tex(ox + x, oy + y1 + k)
      put(ox + x, oy + y1 + k, v < 0 ? -1 : shadedIndex(v))
    }
  }
  return { w: W, h: H, px }
}

// A colour darkened as a wall's front face is: each channel times SHADE, rounded.
export function shadeHex(hex: string): string {
  const n = parseInt(hex.slice(1), 16)
  return '#' + [16, 8, 0].map((sh) => Math.round(((n >> sh) & 255) * SHADE).toString(16).padStart(2, '0')).join('')
}
