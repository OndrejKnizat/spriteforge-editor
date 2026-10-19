// The pixel editor pane's sprite and its edits, as SpriteForge's Edit studio makes them
// (app/edit.html): a stack of layers (bottom first), each holding one cel per frame, on one
// palette; frames carry their own timing and the animation its tags. A selection is a rectangle,
// or a pixel mask inside one; its pixels float on the current layer once moved, pasted or
// transformed, until they are set down.
//
// Every function here takes the editor's state and returns the next one. An edit copies the cels
// it changes rather than changing them in place, so an undo step keeps the whole stack by reference.
import {
  DB32, flipBlock, hexHsv, hsvHex, lum, offsetHalf, outline, placeCel, reducePalette, removeBackground, resample,
  stripOutline, tidy,
} from './tools'

export type Tool = 'brush' | 'eraser' | 'fill' | 'picker' | 'shade' | 'line' | 'rect' | 'ellipse' | 'select' | 'wand' | 'lasso' | 'move' | 'stamp'
export type Layer = { name: string; visible: boolean; locked: boolean; opacity: number; frames: number[][] }
export type Tag = { name: string; from: number; to: number; color: string }
// `mask`: which pixels of the w x h box are selected (absent: all). `float`: the box's pixels
// lifted off the layer (or pasted), -1 where nothing floats. `pv`: the rotation pivot, once moved.
export type Sel = { x: number; y: number; w: number; h: number; mask: boolean[] | null; float: number[] | null; pv: [number, number] | null }
export type Brush = { w: number; h: number; cells: { dx: number; dy: number; hex: string }[] }
export type Tab = 'colour' | 'canvas' | 'layers' | 'frames' | 'export'
// The current cel as a tilemap: its distinct ts x ts tiles (0 the empty one) and which one each
// cell shows. It holds while the cel is the one it was made from (any other edit ends it).
export type Tilemap = { layer: number; frame: number; ts: number; tiles: number[][]; map: number[]; cel: number[]; pick: number }
export type Snap = {
  w: number; h: number; layers: Layer[]; palette: string[]; ms: (number | null)[]; tags: Tag[]; frame: number; layer: number; sel: Sel | null
}

export type Sprite = {
  w: number
  h: number
  palette: string[]
  layers: Layer[]
  ms: (number | null)[] // per frame; null plays at the fps
  tags: Tag[]
  frame: number
  layer: number
  named: number // layers made so far, for the next one's name
  sel: Sel | null
  clip: { x: number; y: number; w: number; h: number; px: (string | null)[] } | null
  fg: string
  bg: string | null // null: transparent
  swatch: number // the swatch last clicked, for remove / edit
  liveSwatch: boolean // colour changes rewrite that swatch everywhere
  reduceN: number
  reduceFrom: Snap | null // a palette reduction on preview: what Revert puts back
  tm: Tilemap | null
  undo: Snap[]
  redo: Snap[]
  note: string
  edits: number
}

export const UNDO_CAP = 60
export const MAX_COLORS = 256
export const MAX_FRAMES = 16 // what one save carries: 16 frames of 64x64 is 65,536 characters
export const MAX_LAYERS = 8
export const MAX_SIDE = 64
export const TAG_COLORS = ['#dcb684', '#7ed08a', '#639bff', '#e08a95', '#a6c9a6', '#d77bba']

export const frameCount = (st: Sprite) => st.ms.length
export const cel = (st: Sprite) => st.layers[st.layer]!.frames[st.frame]!
export const blank = (st: { w: number; h: number }) => new Array<number>(st.w * st.h).fill(-1)
export const inBox = (s: { x: number; y: number; w: number; h: number }, x: number, y: number) => x >= s.x && y >= s.y && x < s.x + s.w && y < s.y + s.h
export const inSel = (s: Sel, x: number, y: number) => inBox(s, x, y) && (!s.mask || s.mask[(y - s.y) * s.w + x - s.x]!)
export const selCount = (s: Sel) => (s.mask ? s.mask.filter(Boolean).length : s.w * s.h)
export const pivot = (s: Sel): [number, number] => s.pv || [s.x + s.w / 2, s.y + s.h / 2]

// The state with its current cel copied, free to change in place; with `palette`, the palette too.
export function editable<S extends Sprite>(st: S, palette = false): S {
  const layers = st.layers.slice(), L = layers[st.layer]!, frames = L.frames.slice()
  frames[st.frame] = frames[st.frame]!.slice()
  layers[st.layer] = { ...L, frames }
  return palette ? { ...st, layers, palette: st.palette.slice() } : { ...st, layers }
}

const snap = (st: Sprite): Snap => ({ w: st.w, h: st.h, layers: st.layers, palette: st.palette, ms: st.ms, tags: st.tags, frame: st.frame, layer: st.layer, sel: st.sel })

export function snapshot<S extends Sprite>(st: S): S {
  return { ...st, undo: st.undo.concat([snap(st)]).slice(-UNDO_CAP), redo: [], edits: st.edits + 1, reduceFrom: null }
}

export function restore<S extends Sprite>(st: S, from: 'undo' | 'redo'): S {
  const stack = from === 'undo' ? st.undo : st.redo
  const s = stack[stack.length - 1]
  if (!s) return { ...st, note: from === 'undo' ? 'Nothing to undo.' : 'Nothing to redo.' }
  const back = snap(st), rest = stack.slice(0, -1)
  return {
    ...st, ...s, note: '', edits: st.edits + 1, reduceFrom: null,
    undo: from === 'undo' ? rest : st.undo.concat([back]),
    redo: from === 'undo' ? st.redo.concat([back]) : rest,
  }
}

// The index of a colour, added to the palette when it is new (edit.html ensureColor). Changes
// `st.palette` in place: call it on a state whose palette is already a copy.
export function ensureColor(st: Sprite, hex: string): number {
  const i = st.palette.indexOf(hex)
  if (i >= 0) return i
  if (st.palette.length >= MAX_COLORS) return nearest(st.palette, hex)
  st.palette.push(hex)
  return st.palette.length - 1
}
function nearest(palette: string[], hex: string): number {
  const n = parseInt(hex.slice(1), 16)
  let best = 0, bd = Infinity
  palette.forEach((c, i) => {
    const m = parseInt(c.slice(1), 16)
    const d = (((n >> 16) & 255) - ((m >> 16) & 255)) ** 2 + (((n >> 8) & 255) - ((m >> 8) & 255)) ** 2 + ((n & 255) - (m & 255)) ** 2
    if (d < bd) { bd = d; best = i }
  })
  return best
}

// The visible layers flattened, upper over lower (opacity is a working aid: it never changes the
// result); with `float`, the floating pixels ride on the current layer.
export function composite(st: Sprite, frame: number, float: boolean, sel = st.sel): number[] {
  const out = blank(st)
  st.layers.forEach((L, li) => {
    if (!L.visible) return
    const d = L.frames[frame]!
    for (let i = 0; i < out.length; i++) if (d[i]! >= 0) out[i] = d[i]!
    if (float && li === st.layer && sel && sel.float) stampOn(out, st, sel)
  })
  return out
}

export function stampOn(d: number[], st: { w: number; h: number }, s: Sel) {
  for (let j = 0; j < s.h; j++) for (let i = 0; i < s.w; i++) {
    const v = s.float![j * s.w + i]!, x = s.x + i, y = s.y + j
    if (v >= 0 && x >= 0 && y >= 0 && x < st.w && y < st.h) d[y * st.w + x] = v
  }
}

// A selection cut to the canvas (a moved one can hang off it); null when nothing is left.
export function clampSel(s: Sel, st: { w: number; h: number }): Sel | null {
  const x0 = Math.max(0, s.x), y0 = Math.max(0, s.y), x1 = Math.min(st.w, s.x + s.w), y1 = Math.min(st.h, s.y + s.h)
  if (x1 <= x0 || y1 <= y0) return null
  const w = x1 - x0, h = y1 - y0
  const mask = s.mask ? Array.from({ length: w * h }, (_, k) => s.mask![(y0 + Math.floor(k / w) - s.y) * s.w + x0 + (k % w) - s.x]!) : null
  if (mask && !mask.some(Boolean)) return null
  return { x: x0, y: y0, w, h, mask, float: null, pv: s.pv }
}

// A mask of canvas cells as a selection, trimmed to its bounding box.
export function selFromCells(cells: Set<number>, st: { w: number; h: number }, pv: [number, number] | null = null): Sel | null {
  if (!cells.size) return null
  let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1
  for (const k of cells) {
    const x = k % st.w, y = (k - x) / st.w
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y)
  }
  const w = x1 - x0 + 1, h = y1 - y0 + 1
  const mask = Array.from({ length: w * h }, (_, k) => cells.has((y0 + Math.floor(k / w)) * st.w + x0 + (k % w)))
  return { x: x0, y: y0, w, h, mask: mask.every(Boolean) ? null : mask, float: null, pv }
}

export function selCells(s: Sel, st: { w: number; h: number }): Set<number> {
  const out = new Set<number>()
  for (let j = 0; j < s.h; j++) for (let i = 0; i < s.w; i++) {
    const x = s.x + i, y = s.y + j
    if (x >= 0 && y >= 0 && x < st.w && y < st.h && (!s.mask || s.mask[j * s.w + i])) out.add(y * st.w + x)
  }
  return out
}

// Sets floating pixels down on the current cel (transparent ones leave what is under them); the
// selection stays, cut to the canvas.
export function stamp<S extends Sprite>(st: S): S {
  const s = st.sel
  if (!s || !s.float) return st
  const next = editable(st)
  stampOn(cel(next), st, s)
  return { ...next, sel: clampSel(s, st) }
}
export const deselect = <S extends Sprite>(st: S): S => (st.sel ? { ...stamp(st), sel: null } : st)

// Lifts the selected pixels off the current cel to float; with `keep`, a copy floats instead.
export function lift<S extends Sprite>(st: S, keep = false): S {
  const s = st.sel
  if (!s || s.float) return st
  const next = keep ? st : editable(st), c = cel(next), from = cel(st)
  const float = new Array<number>(s.w * s.h).fill(-1)
  for (let j = 0; j < s.h; j++) for (let i = 0; i < s.w; i++) {
    if (s.mask && !s.mask[j * s.w + i]) continue
    const k = (s.y + j) * st.w + s.x + i
    float[j * s.w + i] = from[k]!
    if (!keep) c[k] = -1
  }
  return { ...next, sel: { ...s, float } }
}

// A new selection (`op` new), or this one with cells added or taken away (edit.html applyMaskOp).
export function applySel<S extends Sprite>(st: S, cells: Set<number>, op: 'new' | 'add' | 'sub'): S {
  const base = stamp(st)
  let set = cells
  if (op !== 'new') {
    set = base.sel ? selCells(base.sel, base) : new Set<number>()
    for (const k of cells) op === 'add' ? set.add(k) : set.delete(k)
  }
  return { ...base, sel: selFromCells(set, base, op === 'new' ? null : base.sel ? base.sel.pv : null), note: '' }
}

export const rectCells = (st: { w: number }, x0: number, y0: number, x1: number, y1: number) => {
  const out = new Set<number>()
  for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) out.add(y * st.w + x)
  return out
}

export const NO_SEL = 'Select something first: Select, Wand or Lasso.'

export function locked(st: Sprite): string {
  const L = st.layers[st.layer]!
  return L.locked ? `${L.name} is locked: unlock it in Layers to edit it.` : ''
}

export function copy<S extends Sprite>(st: S): S {
  const s = st.sel
  if (!s) return { ...st, note: NO_SEL }
  const src = cel(st), px: (string | null)[] = []
  for (let j = 0; j < s.h; j++) for (let i = 0; i < s.w; i++) {
    const v = s.float ? s.float[j * s.w + i]! : s.mask && !s.mask[j * s.w + i] ? -1 : src[(s.y + j) * st.w + s.x + i]!
    px.push(v >= 0 ? st.palette[v]! : null)
  }
  return { ...st, clip: { x: s.x, y: s.y, w: s.w, h: s.h, px }, note: `Copied ${s.w}x${s.h}.` }
}

// Clears the selected pixels of the current layer (a float just goes).
export function clear<S extends Sprite>(st: S): S {
  const s = st.sel
  if (!s) return { ...st, note: NO_SEL }
  if (locked(st)) return { ...st, note: locked(st) }
  const next = snapshot(st)
  if (s.float) return { ...next, sel: clampSel(s, st), note: '' }
  const e = editable(next), c = cel(e)
  for (const k of selCells(s, st)) c[k] = -1
  return { ...e, note: '' }
}

export const cut = <S extends Sprite>(st: S): S => (st.sel ? { ...clear(copy(st)), note: `Cut ${st.sel.w}x${st.sel.h}.` } : copy(st))

// Pastes where it was copied from, floating, for dragging into place.
export function paste<S extends Sprite>(st: S): S {
  const c = st.clip
  if (!c) return { ...st, note: 'Nothing copied yet (Ctrl+C with a selection).' }
  if (locked(st)) return { ...st, note: locked(st) }
  const next = snapshot(stamp(st)), pal = { ...next, palette: next.palette.slice() }
  const float = c.px.map((hx) => (hx ? ensureColor(pal, hx) : -1))
  const mask = float.every((v) => v >= 0) ? null : float.map((v) => v >= 0)
  return { ...pal, sel: { x: c.x, y: c.y, w: c.w, h: c.h, mask, float, pv: null }, note: 'Pasted: drag it into place.' }
}

export const selectAll = <S extends Sprite>(st: S): S => ({ ...stamp(st), sel: { x: 0, y: 0, w: st.w, h: st.h, mask: null, float: null, pv: null }, note: '' })

export function nudge<S extends Sprite>(st: S, dx: number, dy: number): S {
  if (locked(st)) return { ...st, note: locked(st) }
  const next = st.sel!.float ? st : lift(snapshot(st)), s = next.sel!
  const x = Math.max(1 - s.w, Math.min(st.w - 1, s.x + dx)), y = Math.max(1 - s.h, Math.min(st.h - 1, s.y + dy))
  return { ...next, sel: { ...s, x, y, pv: s.pv ? [s.pv[0] + x - s.x, s.pv[1] + y - s.y] : null }, note: '' }
}

// Flips (or turns a square a quarter clockwise) the floating pixels, else the selection's box on
// the current layer, else the whole current cel (edit.html flipH / flipV / rotate).
export function transform<S extends Sprite>(st: S, how: 'h' | 'v' | 'rot'): S {
  if (locked(st)) return { ...st, note: locked(st) }
  const s = st.sel, word = how === 'h' ? 'Flipped horizontally' : how === 'v' ? 'Flipped vertically' : 'Rotated 90°'
  if (s && s.float) {
    if (how === 'rot' && s.w !== s.h) return { ...st, note: 'Rotate 90° needs a square selection (or none).' }
    const mask = s.mask ? flipBlock(s.mask.map(Number), s.w, s.h, how).map(Boolean) : null
    return { ...snapshot(st), sel: { ...s, float: flipBlock(s.float, s.w, s.h, how), mask }, note: word + '.' }
  }
  const b = s || { x: 0, y: 0, w: st.w, h: st.h }
  if (how === 'rot' && b.w !== b.h) return { ...st, note: 'Rotate 90° needs a square selection (or none).' }
  const next = editable(snapshot(st)), c = cel(next), block: number[] = []
  for (let j = 0; j < b.h; j++) for (let i = 0; i < b.w; i++) block.push(c[(b.y + j) * st.w + b.x + i]!)
  const out = flipBlock(block, b.w, b.h, how)
  for (let j = 0; j < b.h; j++) for (let i = 0; i < b.w; i++) c[(b.y + j) * st.w + b.x + i] = out[j * b.w + i]!
  return { ...next, note: word + (s ? '.' : ' (the current layer and frame; select first to flip part).') }
}

// Moves the current cel's pixels (the Move tool; what goes off the edge is lost, edit.html shiftLayer).
export function shiftLayer<S extends Sprite>(st: S, dx: number, dy: number): S {
  const next = editable(st), from = cel(st), c = cel(next)
  c.fill(-1)
  for (let y = 0; y < st.h; y++) for (let x = 0; x < st.w; x++) {
    const nx = x + dx, ny = y + dy
    if (nx >= 0 && ny >= 0 && nx < st.w && ny < st.h) c[ny * st.w + nx] = from[y * st.w + x]!
  }
  return next
}

// ── the whole canvas ──
// Every cel of every layer rebuilt at a new size (edit.html applyCanvasResize / resizeCanvas /
// cropRegion); the selection goes.
function reshape<S extends Sprite>(st: S, nw: number, nh: number, fn: (d: number[]) => number[], note: string): S {
  const next = snapshot(stamp(st))
  return {
    ...next, w: nw, h: nh, sel: null, note,
    layers: next.layers.map((L) => ({ ...L, frames: L.frames.map(fn) })),
  }
}

// The bounding box of every frame's visible pixels.
export function contentBox(st: Sprite): { x0: number; y0: number; x1: number; y1: number } | null {
  let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1
  for (let f = 0; f < frameCount(st); f++) {
    const g = composite(st, f, f === st.frame)
    for (let i = 0; i < g.length; i++) {
      if (g[i]! < 0) continue
      const x = i % st.w, y = (i - x) / st.w
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y)
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 }
}

export function parseSize(text: string): [number, number] | null {
  const m = /^\s*(\d{1,3})\s*(?:[x×*,]\s*(\d{1,3}))?\s*$/i.exec(text)
  if (!m) return null
  const w = Number(m[1]), h = m[2] ? Number(m[2]) : w
  return w >= 1 && h >= 1 && w <= MAX_SIDE && h <= MAX_SIDE ? [w, h] : null
}

// The anchor that keeps the art where it sits: 0 the start edge, 1 the middle, 2 the end edge.
export function suggestAnchor(st: Sprite): [number, number] {
  const b = contentBox(st)
  if (!b) return [1, 1]
  const cx = (b.x0 + b.x1) / 2 / st.w, cy = (b.y0 + b.y1) / 2 / st.h
  return [cx < 0.34 ? 0 : cx > 0.66 ? 2 : 1, cy < 0.34 ? 0 : cy > 0.66 ? 2 : 1]
}

// New canvas size, no scaling: the art anchored at a corner, side or the middle, or its content centred.
export function canvasSize<S extends Sprite>(st: S, nw: number, nh: number, anchor: [number, number] | 'fit'): S {
  let ox: number, oy: number
  const b = anchor === 'fit' ? contentBox(st) : null
  if (anchor === 'fit' && b) { ox = Math.round(nw / 2 - (b.x0 + b.x1 + 1) / 2); oy = Math.round(nh / 2 - (b.y0 + b.y1 + 1) / 2) }
  else {
    const [ax, ay] = anchor === 'fit' ? [1, 1] : anchor
    ox = Math.round((nw - st.w) * (ax / 2)); oy = Math.round((nh - st.h) * (ay / 2))
  }
  if (nw === st.w && nh === st.h && !ox && !oy) return { ...st, note: 'The canvas is that size already.' }
  const where = anchor === 'fit' ? 'content centred' : `anchored ${ANCHORS[anchor[1] * 3 + anchor[0]]}`
  return reshape(st, nw, nh, (d) => placeCel(d, st.w, st.h, nw, nh, ox, oy), `Canvas ${st.w}x${st.h} -> ${nw}x${nh}, ${where} (no scaling).`)
}
export const ANCHORS = ['top-left', 'top', 'top-right', 'left', 'middle', 'right', 'bottom-left', 'bottom', 'bottom-right']

export function resampleTo<S extends Sprite>(st: S, nw: number, nh: number): S {
  if (nw === st.w && nh === st.h) return { ...st, note: 'The sprite is that size already.' }
  return reshape(st, nw, nh, (d) => resample(d, st.w, st.h, nw, nh), `Resampled ${st.w}x${st.h} -> ${nw}x${nh}.`)
}

function cropTo<S extends Sprite>(st: S, x0: number, y0: number, w: number, h: number, note: string): S {
  return reshape(st, w, h, (d) => placeCel(d, st.w, st.h, w, h, -x0, -y0), note)
}
export function cropToSel<S extends Sprite>(st: S): S {
  const s = st.sel && (st.sel.float ? clampSel(st.sel, st) : st.sel)
  if (!s) return { ...st, note: st.sel ? 'The selection is off the canvas.' : NO_SEL }
  return cropTo(st, s.x, s.y, s.w, s.h, `Cropped to the selection: ${s.w}x${s.h}.`)
}
export function trim<S extends Sprite>(st: S): S {
  const b = contentBox(st)
  if (!b) return { ...st, note: 'Nothing to trim: the sprite is empty.' }
  if (b.x0 === 0 && b.y0 === 0 && b.x1 === st.w - 1 && b.y1 === st.h - 1) return { ...st, note: 'Nothing to trim: the art touches every edge.' }
  return cropTo(st, b.x0, b.y0, b.x1 - b.x0 + 1, b.y1 - b.y0 + 1, `Trimmed the empty border: ${b.x1 - b.x0 + 1}x${b.y1 - b.y0 + 1}.`)
}

// One of the Edit studio's whole-layer tools on the current cel.
export type CelTool = 'outline' | 'strip' | 'rmbg' | 'offset' | 'tidy'
export function celTool<S extends Sprite>(st: S, tool: CelTool, mode: 'tinted' | 'black' | 'white', darkness: number): S {
  if (locked(st)) return { ...st, note: locked(st) }
  const base = stamp(st), d = cel(base)
  let out: number[], palette = base.palette, note: string
  if (tool === 'outline') {
    const r = outline(d, st.w, st.h, palette, mode, darkness)
    out = r.cel; palette = r.palette
    note = `Added a 1px ${mode === 'tinted' ? 'dark-tinted' : mode} outline`
  } else if (tool === 'strip') { out = stripOutline(d, st.w, st.h, palette); note = 'Stripped the outline' }
  else if (tool === 'rmbg') { out = removeBackground(d, st.w, st.h).cel; note = 'Removed the background' }
  else if (tool === 'offset') { out = offsetHalf(d, st.w, st.h); note = 'Offset by half (wrapped): the seams are in the middle now' }
  else { out = tidy(d, st.w, st.h).cel; note = 'Tidy filled' }
  const n = out.reduce((a, v, i) => a + (v !== d[i] ? 1 : 0), 0)
  if (!n) {
    const none = { outline: 'Nothing to outline.', strip: 'No outline found to strip.', rmbg: 'The border is transparent already.', offset: 'Nothing to offset.', tidy: 'Nothing to tidy: no pin-holes.' }
    return { ...base, note: none[tool] }
  }
  const next = editable(snapshot(base))
  next.layers[next.layer]!.frames[next.frame] = out
  return { ...next, palette, note: tool === 'offset' ? note + '.' : tool === 'tidy' ? `${note} ${n} pin-hole${n === 1 ? '' : 's'}.` : `${note} (${n} px).` }
}

// ── palette ──
function remapAll<S extends Sprite>(st: S, map: (v: number) => number): S {
  return {
    ...st,
    layers: st.layers.map((L) => ({ ...L, frames: L.frames.map((d) => d.map((v) => (v < 0 ? v : map(v)))) })),
    sel: st.sel && st.sel.float ? { ...st.sel, float: st.sel.float.map((v) => (v < 0 ? v : map(v))) } : st.sel,
  }
}

export function palAdd<S extends Sprite>(st: S): S {
  if (st.palette.includes(st.fg)) return { ...st, note: `${st.fg} is in the palette already.` }
  if (st.palette.length >= MAX_COLORS) return { ...st, note: `The palette is full (${MAX_COLORS} colours).` }
  const next = snapshot(st)
  return { ...next, palette: st.palette.concat([st.fg]), swatch: st.palette.length, note: `Added ${st.fg}.` }
}

// Removes a swatch: its pixels go transparent and later indexes shift down (edit.html palRemove).
export function palRemove<S extends Sprite>(st: S): S {
  const i = st.swatch
  if (i < 0 || i >= st.palette.length) return { ...st, note: 'Click a swatch first, then Remove.' }
  const hx = st.palette[i]!, next = remapAll(snapshot(stamp(st)), (v) => (v === i ? -1 : v > i ? v - 1 : v))
  const palette = st.palette.filter((_, k) => k !== i)
  return { ...next, palette, swatch: -1, note: `Removed ${hx} and cleared its pixels.` }
}

export function palSort<S extends Sprite>(st: S): S {
  const order = st.palette.map((p, i) => ({ p, i })).sort((a, b) => lum(a.p) - lum(b.p))
  const remap: number[] = []
  order.forEach((o, ni) => { remap[o.i] = ni })
  const next = remapAll(snapshot(st), (v) => remap[v]!)
  return { ...next, palette: order.map((o) => o.p), swatch: st.swatch >= 0 ? remap[st.swatch]! : -1, note: 'Sorted the swatches by brightness.' }
}

export function loadDB32<S extends Sprite>(st: S): S {
  const add = DB32.filter((hx) => !st.palette.includes(hx)).slice(0, MAX_COLORS - st.palette.length)
  if (!add.length) return { ...st, note: 'All 32 DawnBringer colours are in the palette already.' }
  return { ...snapshot(st), palette: st.palette.concat(add), note: `DB32: added ${add.length} colours from the classic 32-colour ramp.` }
}

// Merges the nearest colours until `reduceN` are left, as a preview Keep or Revert settles.
export function palReduce<S extends Sprite>(st: S): S {
  const n = st.reduceN
  if (n >= st.palette.length) return { ...st, note: `The palette has ${st.palette.length} colours already.` }
  const from = snap(st), base = snapshot(stamp(st))
  const r = reducePalette(st.palette, n)
  return { ...remapAll(base, (v) => r.map[v]!), palette: r.palette, swatch: -1, reduceFrom: from, note: `Preview: ${r.palette.length} colours. Keep or Revert?` }
}
export const palKeep = <S extends Sprite>(st: S): S => ({ ...st, reduceFrom: null, note: 'Palette reduction kept.' })
export function palRevert<S extends Sprite>(st: S): S {
  if (!st.reduceFrom) return st
  return { ...st, ...st.reduceFrom, undo: st.undo.slice(0, -1), reduceFrom: null, note: 'Palette reduction reverted.' }
}

// The foreground colour set; with the live swatch on, that swatch takes it everywhere (edit.html
// applyPk while a swatch is being edited; like the studio's, not an undo step of its own).
export function setFg<S extends Sprite>(st: S, hex: string): S {
  if (st.liveSwatch && st.swatch >= 0 && st.swatch < st.palette.length && st.palette[st.swatch] !== hex) {
    const palette = st.palette.slice()
    palette[st.swatch] = hex
    return { ...st, palette, fg: hex, edits: st.edits + 1, note: '' }
  }
  return { ...st, fg: hex, note: '' }
}

// Hue, saturation or value of the foreground stepped (the Edit studio's colour picker, by steps).
export function nudgeHsv<S extends Sprite>(st: S, ch: 'h' | 's' | 'v', by: number): S {
  const c = hexHsv(st.fg)
  if (ch === 'h') c.h = (c.h + by + 360) % 360
  else c[ch] = Math.max(0, Math.min(1, c[ch] + by))
  return setFg(st, hsvHex(c.h, c.s, c.v))
}

export function swapColors<S extends Sprite>(st: S): S {
  if (!st.bg) return { ...st, note: 'The background is transparent: right-click a swatch or the canvas to set it first.' }
  return { ...st, fg: st.bg, bg: st.fg, note: '' }
}

// ── layers ──
export function layerOp<S extends Sprite>(st: S, op: 'add' | 'del' | 'up' | 'down' | 'merge' | 'hide' | 'lock'): S {
  const n = st.layers.length, i = st.layer
  if (op === 'add' && n >= MAX_LAYERS) return { ...st, note: `At most ${MAX_LAYERS} layers.` }
  if (op === 'del' && n < 2) return { ...st, note: 'The only layer stays.' }
  if (op === 'merge' && i === 0) return { ...st, note: 'Nothing below to merge into.' }
  if ((op === 'down' && i === 0) || (op === 'up' && i === n - 1)) return st
  const next = snapshot(stamp(st)), layers = next.layers.slice()
  let layer = i, note = ''
  if (op === 'add') {
    layers.splice(i + 1, 0, { name: `Layer ${st.named + 1}`, visible: true, locked: false, opacity: 100, frames: st.ms.map(() => blank(st)) })
    layer = i + 1
  } else if (op === 'del') {
    layers.splice(i, 1)
    layer = Math.max(0, i - 1)
  } else if (op === 'up' || op === 'down') {
    layer = op === 'up' ? i + 1 : i - 1
    ;[layers[i], layers[layer]] = [layers[layer]!, layers[i]!]
  } else if (op === 'merge') {
    const upper = layers[i]!, below = layers[i - 1]!
    layers[i - 1] = { ...below, frames: below.frames.map((d, f) => d.map((v, k) => (upper.frames[f]![k]! >= 0 ? upper.frames[f]![k]! : v))) }
    layers.splice(i, 1)
    layer = i - 1
    note = `Merged ${upper.name} down into ${below.name}.`
  } else if (op === 'hide') layers[i] = { ...layers[i]!, visible: !layers[i]!.visible }
  else layers[i] = { ...layers[i]!, locked: !layers[i]!.locked }
  return { ...next, layers, layer, named: op === 'add' ? st.named + 1 : st.named, sel: op === 'add' || op === 'del' || op === 'merge' ? null : next.sel, note }
}

export function layerSet<S extends Sprite>(st: S, patch: { name?: string; opacity?: number }): S {
  const layers = st.layers.slice()
  layers[st.layer] = { ...layers[st.layer]!, ...patch }
  return { ...snapshot(st), layers, note: '' }
}

export const pickLayer = <S extends Sprite>(st: S, i: number): S => ({ ...stamp(st), layer: Math.max(0, Math.min(st.layers.length - 1, i)), note: '' })

// ── frames ──
// Tags after a frame is put in or taken out at `idx` (edit.html shiftTags).
function shiftTags(tags: Tag[], idx: number, delta: number, n: number): Tag[] {
  return tags
    .map((t) => ({ ...t, from: t.from >= idx ? t.from + delta : t.from, to: t.to >= idx ? t.to + delta : t.to }))
    .filter((t) => t.to >= t.from && t.from >= 0 && t.to < n)
}

export function frameOp<S extends Sprite>(st: S, op: 'add' | 'dup' | 'del' | 'left' | 'right'): S {
  const n = frameCount(st), f = st.frame
  if ((op === 'add' || op === 'dup') && n >= MAX_FRAMES) return { ...st, note: `At most ${MAX_FRAMES} frames.` }
  if (op === 'del' && n < 2) return { ...st, note: 'The only frame stays.' }
  const to = op === 'left' ? f - 1 : op === 'right' ? f + 1 : f
  if (to < 0 || to >= n) return st
  const next = snapshot(stamp(st)), ms = next.ms.slice()
  const layers = next.layers.map((L) => {
    const fr = L.frames.slice()
    if (op === 'add') fr.splice(f + 1, 0, blank(st))
    else if (op === 'dup') fr.splice(f + 1, 0, fr[f]!)
    else if (op === 'del') fr.splice(f, 1)
    else [fr[f], fr[to]] = [fr[to]!, fr[f]!]
    return { ...L, frames: fr }
  })
  let tags = next.tags
  if (op === 'add' || op === 'dup') { ms.splice(f + 1, 0, op === 'dup' ? ms[f]! : null); tags = shiftTags(tags, f + 1, 1, n + 1) }
  else if (op === 'del') { ms.splice(f, 1); tags = shiftTags(tags, f + 1, -1, n - 1) }
  else [ms[f], ms[to]] = [ms[to]!, ms[f]!]
  const frame = op === 'add' || op === 'dup' ? f + 1 : op === 'del' ? Math.max(0, f - 1) : to
  return { ...next, layers, ms, tags, frame, note: '' }
}

export const goFrame = <S extends Sprite>(st: S, frame: number): S => ({ ...stamp(st), frame })

export function setMs<S extends Sprite>(st: S, text: string): S {
  const t = text.trim()
  if (!t) { const ms = st.ms.slice(); ms[st.frame] = null; return { ...snapshot(st), ms, note: `Frame ${st.frame + 1} plays at the fps.` } }
  const v = Math.round(Number(t.replace(/\s*ms$/i, '')))
  if (!Number.isFinite(v) || v < 20 || v > 5000) return { ...st, note: `"${t}" isn't a duration of 20-5000 ms.` }
  const ms = st.ms.slice()
  ms[st.frame] = v
  return { ...snapshot(st), ms, note: `Frame ${st.frame + 1} shows for ${v} ms.` }
}

// "walk 1-4" (or just "walk": from this frame to the last).
export function addTag<S extends Sprite>(st: S, text: string): S {
  const n = frameCount(st), m = /^\s*(.*?)\s*(?:(\d+)\s*-\s*(\d+))?\s*$/.exec(text)
  const name = (m && m[1] || '').trim()
  if (!name) return { ...st, note: 'Name the tag: "walk 1-4".' }
  let from = m![2] ? Number(m![2]) - 1 : st.frame, to = m![3] ? Number(m![3]) - 1 : n - 1
  from = Math.max(0, Math.min(from, n - 1))
  to = Math.max(from, Math.min(to, n - 1))
  const tag = { name: name.slice(0, 24), from, to, color: TAG_COLORS[st.tags.length % TAG_COLORS.length]! }
  return { ...snapshot(st), tags: st.tags.concat([tag]), note: `Tag "${tag.name}": frames ${from + 1}-${to + 1}. Press it to loop it.` }
}
export const delTag = <S extends Sprite>(st: S, i: number): S => ({ ...snapshot(st), tags: st.tags.filter((_, k) => k !== i), note: '' })

// ── tilemap (edit.html toTilemap / stampAt) ──
export const tilemap = (st: Sprite): Tilemap | null => {
  const t = st.tm
  return t && t.layer === st.layer && t.frame === st.frame && cel(st) === t.cel ? t : null
}
export const tileSizes = (st: { w: number; h: number }) => Array.from({ length: 63 }, (_, i) => i + 2).filter((ts) => st.w % ts === 0 && st.h % ts === 0 && ts < Math.max(st.w, st.h))

export function toTilemap<S extends Sprite>(st: S, ts: number): S {
  if (st.w % ts || st.h % ts) return { ...st, note: `Tiles of ${ts} don't divide the ${st.w}x${st.h} canvas evenly.` }
  const base = stamp(st), c = cel(base), nx = st.w / ts, ny = st.h / ts
  const tiles: number[][] = [new Array(ts * ts).fill(-1)], seen = new Map([[tiles[0]!.join(','), 0]]), map: number[] = []
  for (let ty = 0; ty < ny; ty++) for (let tx = 0; tx < nx; tx++) {
    const t = Array.from({ length: ts * ts }, (_, k) => c[(ty * ts + Math.floor(k / ts)) * st.w + tx * ts + (k % ts)]!), key = t.join(',')
    let i = seen.get(key)
    if (i === undefined) { i = tiles.length; tiles.push(t); seen.set(key, i) }
    map.push(i)
  }
  const n = tiles.length - 1
  return {
    ...base, tm: { layer: st.layer, frame: st.frame, ts, tiles, map, cel: c, pick: Math.min(1, n) }, tool: 'stamp' as Tool,
    note: `Tilemap: ${n} distinct tile${n === 1 ? '' : 's'} of ${ts}x${ts} across ${nx * ny} cells. Pick one and stamp it.`,
  }
}

// Puts the picked tile (right-click: the empty one) in the cell under (x, y); `undoable` makes it a step.
export function stampTile<S extends Sprite>(st: S, x: number, y: number, right: boolean, undoable: boolean): S {
  const t = tilemap(st)
  if (!t) return { ...st, note: 'Make a tilemap of this layer and frame first (Layers).' }
  const nx = st.w / t.ts, cellAt = Math.floor(y / t.ts) * nx + Math.floor(x / t.ts), idx = right ? 0 : t.pick
  if (t.map[cellAt] === idx) return st
  const next = editable(undoable ? snapshot(st) : st), c = cel(next), tile = t.tiles[idx]!
  const ox = (cellAt % nx) * t.ts, oy = Math.floor(cellAt / nx) * t.ts
  for (let k = 0; k < tile.length; k++) c[(oy + Math.floor(k / t.ts)) * st.w + ox + (k % t.ts)] = tile[k]!
  const map = t.map.slice()
  map[cellAt] = idx
  return { ...next, tm: { ...t, map, cel: c }, note: '' }
}
