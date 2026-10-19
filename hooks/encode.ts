// File formats the pixel editor exports, as SpriteForge's Edit studio does (app/edit.html export*,
// app/engine/export.js artToAse): PNG, looping GIF and Aseprite, written from palette-index frames.
// Everything here is plain bytes: register.tsx hands them to the file system.

export type Art = { w: number; h: number; palette: string[]; frames: number[][] }

const rgb = (hx: string): [number, number, number] => {
  const n = parseInt(hx.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

class Bytes {
  buf = new Uint8Array(4096)
  pos = 0
  ensure(n: number) {
    if (this.pos + n <= this.buf.length) return
    let size = this.buf.length * 2
    while (size < this.pos + n) size *= 2
    const b = new Uint8Array(size)
    b.set(this.buf)
    this.buf = b
  }
  u8(v: number) { this.ensure(1); this.buf[this.pos++] = v & 255 }
  u16le(v: number) { this.u8(v); this.u8(v >> 8) }
  u32le(v: number) { this.u16le(v & 0xffff); this.u16le(v >>> 16) }
  u32be(v: number) { this.u8(v >>> 24); this.u8(v >>> 16); this.u8(v >>> 8); this.u8(v) }
  raw(a: ArrayLike<number>) { this.ensure(a.length); this.buf.set(a, this.pos); this.pos += a.length }
  ascii(s: string) { for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i)) }
  patch32le(at: number, v: number) { for (let i = 0; i < 4; i++) this.buf[at + i] = (v >>> (8 * i)) & 255 }
  done() { return this.buf.slice(0, this.pos) }
}

// ── deflate: LZ77 (greedy, 32K window) with the fixed Huffman codes; upscaled pixel art is runs ──
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]

export function deflate(data: Uint8Array): Uint8Array {
  const out = new Bytes()
  let acc = 0, nbits = 0
  const bits = (v: number, n: number) => { // LSB first
    acc |= v << nbits
    nbits += n
    while (nbits >= 8) { out.u8(acc); acc >>>= 8; nbits -= 8 }
  }
  const code = (c: number, n: number) => { // Huffman codes go MSB first
    let r = 0
    for (let i = 0; i < n; i++) r |= ((c >> i) & 1) << (n - 1 - i)
    bits(r, n)
  }
  const lit = (v: number) => {
    if (v < 144) code(0x30 + v, 8)
    else if (v < 256) code(0x190 + v - 144, 9)
    else if (v < 280) code(v - 256, 7)
    else code(0xc0 + v - 280, 8)
  }
  bits(1, 1) // the last block
  bits(1, 2) // fixed codes
  const head = new Int32Array(1 << 15).fill(-1), prev = new Int32Array(data.length)
  const hash = (i: number) => ((data[i]! << 10) ^ (data[i + 1]! << 5) ^ data[i + 2]!) & 0x7fff
  let i = 0
  while (i < data.length) {
    let bestLen = 0, bestDist = 0
    if (i + 2 < data.length) {
      const hv = hash(i)
      let j = head[hv]!, chain = 32
      while (j >= 0 && i - j <= 32768 && chain-- > 0) {
        let n = 0
        while (n < 258 && i + n < data.length && data[j + n] === data[i + n]) n++
        if (n > bestLen) { bestLen = n; bestDist = i - j; if (n === 258) break }
        j = prev[j]!
      }
      prev[i] = head[hv]!
      head[hv] = i
    }
    if (bestLen >= 3) {
      let li = 0
      while (li < 28 && LEN_BASE[li + 1]! <= bestLen) li++
      lit(257 + li)
      if (LEN_EXTRA[li]) bits(bestLen - LEN_BASE[li]!, LEN_EXTRA[li]!)
      let di = 0
      while (di < 29 && DIST_BASE[di + 1]! <= bestDist) di++
      code(di, 5)
      if (DIST_EXTRA[di]) bits(bestDist - DIST_BASE[di]!, DIST_EXTRA[di]!)
      for (let k = 1; k < bestLen; k++) {
        const p = i + k
        if (p + 2 < data.length) { const hv = hash(p); prev[p] = head[hv]!; head[hv] = p }
      }
      i += bestLen
    } else {
      lit(data[i]!)
      i++
    }
  }
  lit(256)
  if (nbits) out.u8(acc)
  return out.done()
}

function zlib(data: Uint8Array): Uint8Array {
  let a = 1, b = 0
  for (let i = 0; i < data.length; i++) { a = (a + data[i]!) % 65521; b = (b + a) % 65521 }
  const out = new Bytes()
  out.u8(0x78); out.u8(0x01)
  out.raw(deflate(data))
  out.u32be(((b << 16) | a) >>> 0)
  return out.done()
}

const CRC = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(a: Uint8Array, from: number, to: number): number {
  let c = 0xffffffff
  for (let i = from; i < to; i++) c = CRC[(c ^ a[i]!) & 255]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

// What made the file, as image editors sign theirs: a PNG's Software text, a GIF's comment.
export const CREDIT = 'SpriteForge Editor (https://www.spriteforge.tech)'
const latin1 = (s: string) => Array.from(s, (c) => c.charCodeAt(0) & 255)

// One frame (or frames laid side by side, `cols` across) as a PNG, each pixel `scale` x `scale`:
// indexed with a transparent entry while the palette leaves room for one, else RGBA.
export function png(art: Art, frames: number[], scale: number, cols = frames.length): Uint8Array {
  const rows = Math.ceil(frames.length / cols), W = art.w * cols * scale, H = art.h * rows * scale
  const indexed = art.palette.length < 256, T = art.palette.length
  const stride = indexed ? W + 1 : W * 4 + 1, raw = new Uint8Array(stride * H)
  const cols3 = art.palette.map(rgb)
  for (let Y = 0; Y < H; Y++) {
    raw[Y * stride] = 0
    const fy = Math.floor(Y / (art.h * scale)), y = Math.floor((Y % (art.h * scale)) / scale)
    for (let X = 0; X < W; X++) {
      const fx = Math.floor(X / (art.w * scale)), f = frames[fy * cols + fx]
      const v = f === undefined ? -1 : art.frames[f]![y * art.w + Math.floor((X % (art.w * scale)) / scale)]!
      if (indexed) raw[Y * stride + 1 + X] = v < 0 ? T : v
      else if (v >= 0) {
        const o = Y * stride + 1 + X * 4, c = cols3[v]!
        raw[o] = c[0]; raw[o + 1] = c[1]; raw[o + 2] = c[2]; raw[o + 3] = 255
      }
    }
  }
  const out = new Bytes()
  out.raw([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const chunk = (type: string, body: ArrayLike<number>) => {
    out.u32be(body.length)
    const at = out.pos
    out.ascii(type)
    out.raw(body)
    out.u32be(crc32(out.buf, at, out.pos))
  }
  const ihdr = new Bytes()
  ihdr.u32be(W); ihdr.u32be(H); ihdr.u8(8); ihdr.u8(indexed ? 3 : 6); ihdr.u8(0); ihdr.u8(0); ihdr.u8(0)
  chunk('IHDR', ihdr.done())
  chunk('tEXt', latin1('Software').concat([0], latin1(CREDIT)))
  if (indexed) {
    chunk('PLTE', cols3.concat([[0, 0, 0]]).flat())
    chunk('tRNS', new Array(T).fill(255).concat([0]))
  }
  chunk('IDAT', zlib(raw))
  chunk('IEND', [])
  return out.done()
}

// A looping GIF89a, per-frame delays, transparency (edit.html exportGif: 8x, 4x past 64px).
export function gif(art: Art, ms: number[]): Uint8Array {
  if (art.palette.length > 254) throw new Error('GIF takes up to 254 colours: reduce the palette first.')
  const pal = art.palette.map(rgb), trans = pal.length
  let gctBits = 2
  while (1 << gctBits < pal.length + 1) gctBits++
  const scale = Math.max(art.w, art.h) <= 64 ? 8 : 4, W = art.w * scale, H = art.h * scale
  const out = new Bytes()
  out.ascii('GIF89a'); out.u16le(W); out.u16le(H)
  out.u8(0x80 | ((gctBits - 1) << 4) | (gctBits - 1)); out.u8(trans); out.u8(0)
  for (let i = 0; i < 1 << gctBits; i++) out.raw(pal[i] || [0, 0, 0])
  out.raw([0x21, 0xff, 11]); out.ascii('NETSCAPE2.0'); out.raw([3, 1, 0, 0, 0])
  out.raw([0x21, 0xfe, CREDIT.length]); out.raw(latin1(CREDIT)); out.u8(0)
  art.frames.forEach((g, f) => {
    out.raw([0x21, 0xf9, 4, 0x09]); out.u16le(Math.max(2, Math.round((ms[f] || 100) / 10))); out.raw([trans, 0])
    out.u8(0x2c); out.u16le(0); out.u16le(0); out.u16le(W); out.u16le(H); out.u8(0)
    const px = new Uint8Array(W * H)
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const v = g[Math.floor(y / scale) * art.w + Math.floor(x / scale)]!
      px[y * W + x] = v < 0 ? trans : v
    }
    const minCode = Math.max(2, gctBits)
    out.u8(minCode)
    lzw(minCode, px, out)
    out.u8(0)
  })
  out.u8(0x3b)
  return out.done()
}

function lzw(minCodeSize: number, pixels: Uint8Array, out: Bytes) {
  const CLEAR = 1 << minCodeSize, EOI = CLEAR + 1
  let codeSize = minCodeSize + 1, next = EOI + 1, dict = new Map<number, number>()
  const chunk: number[] = []
  let cur = 0, nbits = 0
  const emit = (c: number) => {
    cur |= c << nbits
    nbits += codeSize
    while (nbits >= 8) { chunk.push(cur & 255); cur >>= 8; nbits -= 8 }
  }
  emit(CLEAR)
  let w = pixels[0]!
  for (let i = 1; i < pixels.length; i++) {
    const c = pixels[i]!, key = (w << 8) | c
    const hit = dict.get(key)
    if (hit !== undefined) { w = hit; continue }
    emit(w)
    if (next < 4096) {
      dict.set(key, next++)
      if (next > 1 << codeSize && codeSize < 12) codeSize++
    } else {
      emit(CLEAR)
      dict = new Map(); next = EOI + 1; codeSize = minCodeSize + 1
    }
    w = c
  }
  emit(w); emit(EOI)
  if (nbits > 0) chunk.push(cur & 255)
  for (let i = 0; i < chunk.length; i += 255) {
    const s = chunk.slice(i, i + 255)
    out.u8(s.length)
    out.raw(s)
  }
}

// A native Aseprite file: RGBA, raw cels, a layer per layer and a frame per frame with its
// duration (app/engine/export.js artToAse, grown from its one frame).
export function ase(w: number, h: number, palette: string[], layers: { name: string; frames: number[][] }[], ms: number[]): Uint8Array {
  const pal = palette.map(rgb), out = new Bytes()
  const fileSizeAt = out.pos
  out.u32le(0)
  out.u16le(0xa5e0); out.u16le(ms.length); out.u16le(w); out.u16le(h); out.u16le(32); out.u32le(1); out.u16le(100)
  out.u32le(0); out.u32le(0); out.u8(0); out.raw([0, 0, 0]); out.u16le(0); out.u8(1); out.u8(1)
  out.u16le(0); out.u16le(0); out.u16le(16); out.u16le(16); out.raw(new Uint8Array(84))
  ms.forEach((dur, f) => {
    const frameAt = out.pos
    out.u32le(0)
    out.u16le(0xf1fa); out.u16le(0xffff); out.u16le(Math.max(1, Math.min(65535, Math.round(dur)))); out.raw([0, 0])
    out.u32le(layers.length * (f === 0 ? 2 : 1))
    layers.forEach((L, li) => {
      if (f === 0) {
        const at = out.pos
        out.u32le(0); out.u16le(0x2004)
        out.u16le(3); out.u16le(0); out.u16le(0); out.u16le(0); out.u16le(0); out.u16le(0); out.u8(255); out.raw([0, 0, 0])
        const name = Array.from(L.name || `Layer ${li + 1}`, (c) => (c.charCodeAt(0) < 128 ? c : '?')).join('')
        out.u16le(name.length); out.ascii(name)
        out.patch32le(at, out.pos - at)
      }
      const at = out.pos
      out.u32le(0); out.u16le(0x2005)
      out.u16le(li); out.u16le(0); out.u16le(0); out.u8(255); out.u16le(0); out.raw(new Uint8Array(7)); out.u16le(w); out.u16le(h)
      const g = L.frames[f]!, px = new Uint8Array(w * h * 4)
      for (let i = 0; i < w * h; i++) {
        const v = g[i]!
        if (v < 0) continue
        const c = pal[v]!
        px[i * 4] = c[0]; px[i * 4 + 1] = c[1]; px[i * 4 + 2] = c[2]; px[i * 4 + 3] = 255
      }
      out.raw(px)
      out.patch32le(at, out.pos - at)
    })
    out.patch32le(frameAt, out.pos - frameAt)
  })
  out.patch32le(fileSizeAt, out.pos)
  return out.done()
}

export function base64(a: Uint8Array): string {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let s = ''
  for (let i = 0; i < a.length; i += 3) {
    const n = (a[i]! << 16) | ((a[i + 1] ?? 0) << 8) | (a[i + 2] ?? 0)
    s += A[(n >> 18) & 63]! + A[(n >> 12) & 63]! + (i + 1 < a.length ? A[(n >> 6) & 63]! : '=') + (i + 2 < a.length ? A[n & 63]! : '=')
  }
  return s
}

// The Edit studio's text export: a legend, then one character per pixel ("." transparent).
export function asciiArt(name: string, art: Art): string {
  const chars = '.abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const legend = art.palette.map((p, i) => `${chars[i + 1] || '?'} = ${p}`).join('\n')
  const body = (g: number[]) => Array.from({ length: art.h }, (_, y) => g.slice(y * art.w, y * art.w + art.w).map((v) => (v < 0 ? '.' : chars[v + 1] || '?')).join('')).join('\n')
  const frames = art.frames.length > 1 ? art.frames.map((g, i) => `# frame ${i + 1}\n${body(g)}`).join('\n\n') : body(art.frames[0]!)
  return `# ${name} · ${art.w}x${art.h}\n${legend}\n\n${frames}\n`
}
