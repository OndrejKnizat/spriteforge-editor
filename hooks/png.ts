// PNG -> sprite, in plain TypeScript: the mod runs with no Node and no DOM, so there is no zlib to
// call. Decodes every standard PNG (colour types 0/2/3/4/6, bit depths 1-16, tRNS, Adam7) to 8-bit
// RGBA, then to a sprite: a palette of hex colours and a grid of palette indexes, -1 transparent.
// Pixel art has hard alpha: anything under half opacity becomes a transparent cell.

export type Sprite = { w: number; h: number; palette: string[]; grid: number[] }

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }
const DEPTHS: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] as const

// ── inflate (RFC 1950/1951) ─────────────────────────────────────────────────────────────────────

type Huffman = { counts: Uint16Array; symbols: Uint16Array }

function huffman(lengths: Uint8Array, n: number): Huffman {
  const counts = new Uint16Array(16), symbols = new Uint16Array(n), offs = new Uint16Array(16)
  for (let i = 0; i < n; i++) counts[lengths[i]!]!++
  counts[0] = 0
  for (let i = 1; i < 16; i++) offs[i] = offs[i - 1]! + counts[i - 1]!
  for (let i = 0; i < n; i++) if (lengths[i]) symbols[offs[lengths[i]!]!++] = i
  return { counts, symbols }
}

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]

let fixedLit: Huffman | null = null, fixedDist: Huffman | null = null
function fixedTables(): [Huffman, Huffman] {
  if (!fixedLit || !fixedDist) {
    const l = new Uint8Array(288)
    l.fill(8, 0, 144); l.fill(9, 144, 256); l.fill(7, 256, 280); l.fill(8, 280, 288)
    fixedLit = huffman(l, 288)
    fixedDist = huffman(new Uint8Array(30).fill(5), 30)
  }
  return [fixedLit, fixedDist]
}

// Inflates a zlib stream; `limit` bounds the output so a hostile file can't balloon.
export function inflate(src: Uint8Array, limit: number): Uint8Array {
  if (src.length < 2 || (src[0]! & 15) !== 8 || ((src[0]! << 8) | src[1]!) % 31 !== 0) throw new Error("not a zlib stream")
  let pos = 2, bit = 0, bits = 0
  let out = new Uint8Array(Math.min(limit, Math.max(1024, src.length * 4))), len = 0
  const need = (n: number) => {
    if (len + n <= out.length) return
    if (len + n > limit) throw new Error("image data is larger than its header says")
    const next = new Uint8Array(Math.min(limit, Math.max(out.length * 2, len + n)))
    next.set(out.subarray(0, len)); out = next
  }
  const getBits = (n: number): number => {
    while (bits < n) {
      if (pos >= src.length) throw new Error("image data is truncated")
      bit |= src[pos++]! << bits; bits += 8
    }
    const v = bit & ((1 << n) - 1)
    bit >>>= n; bits -= n
    return v
  }
  const decode = (t: Huffman): number => {
    let code = 0, first = 0, index = 0
    for (let l = 1; l < 16; l++) {
      code |= getBits(1)
      const count = t.counts[l]!
      if (code - count < first) return t.symbols[index + (code - first)]!
      index += count; first += count; first <<= 1; code <<= 1
    }
    throw new Error("corrupt image data")
  }
  let last = 0
  while (!last) {
    last = getBits(1)
    const type = getBits(2)
    if (type === 0) {
      bit = 0; bits = 0
      if (pos + 4 > src.length) throw new Error("image data is truncated")
      const n = src[pos]! | (src[pos + 1]! << 8)
      pos += 4
      if (pos + n > src.length) throw new Error("image data is truncated")
      need(n); out.set(src.subarray(pos, pos + n), len); len += n; pos += n
      continue
    }
    let lit: Huffman, dist: Huffman
    if (type === 1) [lit, dist] = fixedTables()
    else if (type === 2) {
      const hlit = getBits(5) + 257, hdist = getBits(5) + 1, hclen = getBits(4) + 4
      const cl = new Uint8Array(19)
      for (let i = 0; i < hclen; i++) cl[CL_ORDER[i]!] = getBits(3)
      const clt = huffman(cl, 19)
      const lens = new Uint8Array(hlit + hdist)
      for (let i = 0; i < hlit + hdist;) {
        const sym = decode(clt)
        if (sym < 16) lens[i++] = sym
        else {
          let rep = 0, val = 0
          if (sym === 16) { if (!i) throw new Error("corrupt image data"); val = lens[i - 1]!; rep = 3 + getBits(2) }
          else if (sym === 17) rep = 3 + getBits(3)
          else rep = 11 + getBits(7)
          if (i + rep > hlit + hdist) throw new Error("corrupt image data")
          lens.fill(val, i, i + rep); i += rep
        }
      }
      lit = huffman(lens.subarray(0, hlit), hlit)
      dist = huffman(lens.subarray(hlit), hdist)
    } else throw new Error("corrupt image data")
    for (;;) {
      const sym = decode(lit)
      if (sym < 256) { need(1); out[len++] = sym; continue }
      if (sym === 256) break
      const li = sym - 257
      if (li >= 29) throw new Error("corrupt image data")
      const n = LEN_BASE[li]! + getBits(LEN_EXTRA[li]!)
      const di = decode(dist)
      if (di >= 30) throw new Error("corrupt image data")
      const d = DIST_BASE[di]! + getBits(DIST_EXTRA[di]!)
      if (d > len) throw new Error("corrupt image data")
      need(n)
      for (let k = 0; k < n; k++, len++) out[len] = out[len - d]!
    }
  }
  return out.subarray(0, len)
}

// ── PNG ─────────────────────────────────────────────────────────────────────────────────────────

const u32 = (b: Uint8Array, o: number) => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0
const u16 = (b: Uint8Array, o: number) => (b[o]! << 8) | b[o + 1]!

function paeth(a: number, b: number, c: number) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

function unfilter(raw: Uint8Array, offset: number, h: number, rowBytes: number, bpp: number): Uint8Array {
  const out = new Uint8Array(h * rowBytes)
  for (let y = 0; y < h; y++) {
    const type = raw[offset + y * (rowBytes + 1)]!
    const src = offset + y * (rowBytes + 1) + 1, dst = y * rowBytes, prev = dst - rowBytes
    for (let x = 0; x < rowBytes; x++) {
      const v = raw[src + x]!
      const a = x >= bpp ? out[dst + x - bpp]! : 0
      const b = y > 0 ? out[prev + x]! : 0
      const c = x >= bpp && y > 0 ? out[prev + x - bpp]! : 0
      const r = type === 0 ? v : type === 1 ? v + a : type === 2 ? v + b : type === 3 ? v + ((a + b) >> 1) : type === 4 ? v + paeth(a, b, c) : NaN
      if (Number.isNaN(r)) throw new Error("corrupt PNG (unknown scanline filter)")
      out[dst + x] = r & 255
    }
  }
  return out
}

export function decodePng(buf: Uint8Array, maxSide: number): { width: number; height: number; rgba: Uint8Array } {
  const SIG = [137, 80, 78, 71, 13, 10, 26, 10]
  if (buf.length < 33 || SIG.some((v, i) => buf[i] !== v)) throw new Error("that file isn't a PNG")
  let pos = 8, w = 0, h = 0, depth = 0, colorType = -1, interlace = 0
  let palette: Uint8Array | null = null, trns: Uint8Array | null = null
  const idat: Uint8Array[] = []
  while (pos + 8 <= buf.length) {
    const n = u32(buf, pos), type = String.fromCharCode(buf[pos + 4]!, buf[pos + 5]!, buf[pos + 6]!, buf[pos + 7]!)
    const data = buf.subarray(pos + 8, pos + 8 + n)
    if (data.length !== n) throw new Error(`corrupt PNG (truncated ${type} chunk)`)
    pos += 12 + n
    if (type === "IHDR") { w = u32(data, 0); h = u32(data, 4); depth = data[8]!; colorType = data[9]!; interlace = data[12]! }
    else if (type === "PLTE") palette = data
    else if (type === "tRNS") trns = data
    else if (type === "IDAT") idat.push(data)
    else if (type === "IEND") break
  }
  const channels = CHANNELS[colorType]
  if (!channels || !DEPTHS[colorType]!.includes(depth)) throw new Error("unsupported PNG colour type or bit depth")
  if (w < 1 || h < 1) throw new Error("the PNG has no pixels")
  if (w > maxSide || h > maxSide) throw new Error(`the image is ${w}x${h}; the editor takes up to ${maxSide}x${maxSide}`)
  if (colorType === 3 && !palette) throw new Error("corrupt PNG (palette image without a palette)")
  if (!idat.length) throw new Error("corrupt PNG (no image data)")

  const bitsPerPixel = channels * depth, bpp = Math.max(1, bitsPerPixel >> 3)
  const passes = interlace
    ? ADAM7.map(([x0, y0, dx, dy]) => ({ x0, y0, dx, dy, w: Math.max(0, Math.ceil((w - x0) / dx)), h: Math.max(0, Math.ceil((h - y0) / dy)) }))
    : [{ x0: 0, y0: 0, dx: 1, dy: 1, w, h }]
  let expected = 0
  for (const p of passes) if (p.w && p.h) expected += p.h * (1 + Math.ceil((p.w * bitsPerPixel) / 8))
  const total = idat.reduce((s, c) => s + c.length, 0)
  const z = new Uint8Array(total)
  let o = 0
  for (const c of idat) { z.set(c, o); o += c.length }
  const raw = inflate(z, expected + 1024)
  if (raw.length < expected) throw new Error("corrupt PNG (image data is truncated)")

  const trnsGray = colorType === 0 && trns && trns.length >= 2 ? u16(trns, 0) : null
  const trnsRgb = colorType === 2 && trns && trns.length >= 6 ? [u16(trns, 0), u16(trns, 2), u16(trns, 4)] : null
  const maxSample = (1 << depth) - 1
  const to8 = (s: number) => (depth === 16 ? s >> 8 : depth === 8 ? s : Math.round((s * 255) / maxSample))
  const rgba = new Uint8Array(w * h * 4)
  let offset = 0
  for (const p of passes) {
    if (!p.w || !p.h) continue
    const rowBytes = Math.ceil((p.w * bitsPerPixel) / 8)
    const px = unfilter(raw, offset, p.h, rowBytes, bpp)
    offset += p.h * (rowBytes + 1)
    const sample = (row: number, i: number) => {
      if (depth === 8) return px[row + i]!
      if (depth === 16) return u16(px, row + i * 2)
      const b = i * depth
      return (px[row + (b >> 3)]! >> (8 - depth - (b & 7))) & maxSample
    }
    for (let y = 0; y < p.h; y++) {
      const row = y * rowBytes
      for (let x = 0; x < p.w; x++) {
        const at = ((p.y0 + y * p.dy) * w + (p.x0 + x * p.dx)) * 4, i = x * channels
        let r: number, g: number, b: number, a = 255
        if (colorType === 3) {
          const k = sample(row, i)
          if (k * 3 + 2 >= palette!.length) throw new Error("corrupt PNG (palette index out of range)")
          r = palette![k * 3]!; g = palette![k * 3 + 1]!; b = palette![k * 3 + 2]!
          if (trns && k < trns.length) a = trns[k]!
        } else if (colorType === 0 || colorType === 4) {
          const s = sample(row, i)
          r = g = b = to8(s)
          if (colorType === 4) a = to8(sample(row, i + 1))
          else if (trnsGray != null && s === trnsGray) a = 0
        } else {
          const sr = sample(row, i), sg = sample(row, i + 1), sb = sample(row, i + 2)
          r = to8(sr); g = to8(sg); b = to8(sb)
          if (colorType === 6) a = to8(sample(row, i + 3))
          else if (trnsRgb && sr === trnsRgb[0] && sg === trnsRgb[1] && sb === trnsRgb[2]) a = 0
        }
        rgba[at] = r; rgba[at + 1] = g; rgba[at + 2] = b; rgba[at + 3] = a
      }
    }
  }
  return { width: w, height: h, rgba }
}

const hex2 = (v: number) => v.toString(16).padStart(2, "0")

// RGBA -> palette + index grid (first-seen colour order), at most `maxColors` colours.
export function spriteFromRgba(w: number, h: number, rgba: Uint8Array, maxColors: number): Sprite {
  const palette: string[] = [], index = new Map<string, number>(), grid = new Array<number>(w * h)
  for (let i = 0; i < w * h; i++) {
    if (rgba[i * 4 + 3]! < 128) { grid[i] = -1; continue }
    const hx = "#" + hex2(rgba[i * 4]!) + hex2(rgba[i * 4 + 1]!) + hex2(rgba[i * 4 + 2]!)
    let k = index.get(hx)
    if (k === undefined) {
      if (palette.length >= maxColors) throw new Error(`the image has more than ${maxColors} colours; it doesn't look like pixel art`)
      k = palette.length; palette.push(hx); index.set(hx, k)
    }
    grid[i] = k
  }
  return { w, h, palette, grid }
}

export function spriteFromPng(buf: Uint8Array, maxSide: number, maxColors: number): Sprite {
  const { width, height, rgba } = decodePng(buf, maxSide)
  return spriteFromRgba(width, height, rgba, maxColors)
}
