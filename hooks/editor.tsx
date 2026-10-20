// The editor region of the pane: a Client module, run on the drawing thread with its own state.
// The canvas is drawn first (pixels.tsx), so pointer rows 0..canvasRows map straight onto pixels;
// the palette, tools, their options and a tabbed panel (Colour, Canvas, Layers, Frames, Export)
// sit under it as ordinary Buttons, Inputs and Selects. The tools and what they do follow
// SpriteForge's Edit studio (app/edit.html); the sprite and its edits live in sprite.ts.
import type { ClientKeyEvent, ClientModule, ClientPointerEvent, ClientSurface } from 'claude-code'

import type { DrawDoc } from '../types'
import {
  BACKDROPS, EDGE, EDGE_EMPTY, EMPTY, GHOST, GRID_LINE_COST, HANDLE, OVERVIEW_BUDGET, PICK_H, PIVOT, SOLID, canvas, chips, colourNow, decodeFrame, encodeFrame, fit,
  gridLines, overview, pickFor, pickStep, pickerHit, pickerRows, pixelAt, rowsShown, swatchAt, swatchRows, zoomStep,
} from './pixels'
import type { Geo, Look, Swatch } from './pixels'
import {
  ANCHORS, NO_SEL, addTag, applySel, canvasSize, cel, celTool, clear, composite, copy, cropToSel, cut, delTag, deselect,
  editable, ensureColor, frameCount, frameOp, goFrame, inSel, layerOp, layerSet, lift, loadDB32, locked, nudge, nudgeHsv,
  palAdd, palKeep, palReduce, palRemove, palRevert, palSort, parseSize, paste, pickLayer, pivot, rectCells, resampleTo, restore,
  selCount, selFromCells, selectAll, setFg, setMs, shiftLayer, snapshot, stamp, stampTile, suggestAnchor, swapColors, tileSizes,
  tilemap, toTilemap, transform, trim,
} from './sprite'
import type { Brush, CelTool, Sel, Sprite, Tab, Tool } from './sprite'
import { brushCells, hexHsv, hsvHex, lassoCells, lineCells, mixHex, region, resample, rotMap, shapeCells, shiftHex } from './tools'

type Pt = [number, number]
type Op = 'new' | 'add' | 'sub'
type Corner = 'nw' | 'ne' | 'sw' | 'se'
type Paint = { kind: 'paint'; right: boolean; x: number; y: number; trail: Pt[]; orig: Map<number, number>; shaded: Set<number> }
type Shape = { kind: 'shape'; right: boolean; x0: number; y0: number; x1: number; y1: number }
type Drag =
  | Paint
  | Shape
  | { kind: 'marquee'; op: Op; x0: number; y0: number; x1: number; y1: number }
  | { kind: 'lasso'; op: Op; pts: Pt[] }
  | { kind: 'move'; dx: number; dy: number }
  | { kind: 'scale'; corner: Corner; base: Sel; to: Sel }
  | { kind: 'rotate'; base: Sel; a0: number; to: Sel | null; deg: number }
  | { kind: 'layer'; x0: number; y0: number; base: number[] }
  | { kind: 'stamp'; right: boolean }
type State = Sprite & {
  rev: number
  tool: Tool
  size: number // brush 1-8
  round: boolean
  perfect: boolean // pixel-perfect freehand (1px brush)
  symX: boolean
  symY: boolean
  strength: number // shade, percent
  global: boolean // fill every pixel of the colour
  filled: boolean // rect and ellipse
  brush: Brush | null // a custom brush (Ctrl+B)
  target: 'fg' | 'bg' // what swatches, the colour field and the HSV steps set
  outlineMode: 'tinted' | 'black' | 'white'
  darkness: number
  anchor: [number, number] | 'fit' | null // canvas resize; null: where the art sits
  pivotMode: boolean // the next click on the canvas sets the rotation pivot
  fps: number
  playing: boolean
  playAt: number
  playTag: number
  onion: boolean
  onionBack: number
  onionFwd: number
  drag: Drag | null
  last: Pt | null // the last point painted, for Shift+click lines
  hover: Pt | null
  zoom: number // 0 = fit; 0.5 = half blocks; 1..4 = block size
  top: number // first band drawn
  tile3: boolean // the sprite drawn 3x3 to check it tiles; painting wraps
  left: number // first pixel column drawn, when the sprite is wider than the pane
  backdrop: number
  grid: boolean // the pixel grid: hairlines on the desktop, a tint on the terminal
  picker: boolean // the colour picker under the canvas, while the Colour tab is open
  pick: [number, number, number] // its hue, saturation and value, kept so a grey keeps its hue
  pickDrag: 'sv' | 'hue' | null // dragging in the square or along the hue strip
  help: boolean // the shortcut sheet
  more: boolean // the Colour tab's less common tools: HSV steps, swatch editing, sorting, reducing, DB32
  tab: Tab
  seen: number // the last export notice shown
  tileSize: number // for a new tilemap
}
type Notice = { id: number; text: string }
type Props = { doc: DrawDoc; cols: number; rows: number; notice?: Notice | null; surface?: string }

const CANVAS_BUDGET = 62_000 // serialized characters for the canvas; the controls take the rest
const PICKER_BUDGET = 26_000 // the colour picker's share of it, while it is open
const PALETTE_SHOWN = 64
const CHIP_COST = 330 // what a palette chip serializes to, about, so the canvas leaves room for them
const ACCENT = '#dcb684' // the selection's edge where it crosses transparent pixels
const BACK = '#e08a95', FWD = '#7ed08a' // onion skin: frames behind, frames ahead (Aseprite's)
const TOOLS: [Tool, string][] = [['brush', 'Brush'], ['eraser', 'Eraser'], ['fill', 'Fill'], ['picker', 'Pick'], ['shade', 'Shade'],
  ['line', 'Line'], ['rect', 'Rect'], ['ellipse', 'Oval'], ['select', 'Select'], ['wand', 'Wand'], ['lasso', 'Lasso'], ['move', 'Move']]
const KEYS: Record<string, Tool> = { b: 'brush', p: 'brush', e: 'eraser', g: 'fill', f: 'fill', i: 'picker', s: 'shade', l: 'line',
  u: 'rect', o: 'ellipse', m: 'select', w: 'wand', q: 'lasso', v: 'move' }
// The toolbar's groups, and the line under it: the tool, its key and what it does. Nothing reacts to
// hover inside a desktop pane, so this stands in for tooltips.
const TOOL_GROUPS: Tool[][] = [['brush', 'eraser', 'fill', 'picker', 'shade'], ['line', 'rect', 'ellipse'], ['select', 'wand', 'lasso', 'move']]
const TOOL_KEY: Partial<Record<Tool, string>> = { brush: 'B', eraser: 'E', fill: 'G', picker: 'I', shade: 'S', line: 'L', rect: 'U', ellipse: 'Shift+U',
  select: 'M', wand: 'W', lasso: 'Q', move: 'V' }
const TOOL_HELP: Record<Tool, string> = {
  brush: 'click to paint · right-click paints the background · Shift+click draws a line · Alt+click picks a colour',
  eraser: 'click to erase to transparent',
  fill: 'click to fill an area of one colour · right-click fills with transparency · Global fills every pixel of that colour',
  picker: 'click to take a colour from the canvas · right-click takes it as the background',
  shade: 'paint to darken · right-click lightens',
  line: 'drag from end to end · right-drag uses the background',
  rect: 'drag from corner to corner · right-drag uses the background',
  ellipse: 'drag from corner to corner · right-drag uses the background',
  select: 'drag to select (Shift adds, right-drag takes away) · drag inside to move, a corner to scale, just outside to turn · Enter sets it down',
  wand: 'click to select the touching pixels of one colour · Shift adds, right-click takes away · arrows nudge',
  lasso: 'draw around an area to select it · Shift adds, right-click takes away',
  move: 'drag to slide the layer',
  stamp: 'click a cell to put the picked tile there · right-click empties it',
}
const SHORTCUTS = [
  'Tools: B brush · E eraser · G fill · I pick · S shade · L line · U rect · Shift+U oval · M select · W wand · Q lasso · V move',
  'Edit: Ctrl+Z undo · Ctrl+Shift+Z redo · Ctrl+C / X / V copy, cut, paste · Ctrl+A all · Ctrl+D deselect · Delete clears · Ctrl+B to brush · Shift+H / Shift+V flip',
  'View: + and - zoom · 0 fits · 1-5 zoom steps · Up / Down and Shift+Left / Right scroll · X swaps colours · [ and ] brush size · Space plays · Left / Right frames · Ctrl+S save to prompt',
]
// The colour picker under the canvas (pixels.tsx pickerRows), and the palette's rows under it: where
// each starts, so a press there picks a colour.
const pickerTop = new WeakMap<object, number>()
const paletteAt = new WeakMap<object, { top: number; count: number; cols: number }>()
// Where the overview of a wide sprite sits (pixels.tsx overview): a press there moves the view.
const overviewAt = new WeakMap<object, { top: number; height: number; pw: number; step: number }>()
const TABS: [Tab, string][] = [['colour', 'Colour'], ['canvas', 'Canvas'], ['layers', 'Layers'], ['frames', 'Frames'], ['export', 'Export']]
const EXPORTS: [string, string][] = [['png', 'PNG'], ['png8', 'PNG 8x'], ['sheet', 'Sheet'], ['gif', 'GIF'], ['frames', 'Frames'], ['ase', 'Aseprite'], ['txt', 'Text']]
const CEL_TOOLS: [CelTool, string][] = [['strip', 'Strip outline'], ['rmbg', 'Remove BG'], ['offset', 'Offset ½'], ['tidy', 'Tidy']]
const PAINTS = new Set<Tool>(['brush', 'eraser', 'shade'])
const SELECTS = new Set<Tool>(['select', 'wand', 'lasso'])
const SHAPES = new Set<Tool>(['line', 'rect', 'ellipse'])
const geometry = new WeakMap<object, Geo>()
const timers = new WeakMap<object, () => void>()

function fromDoc(doc: DrawDoc): State {
  const n = doc.w * doc.h
  return {
    rev: doc.rev, w: doc.w, h: doc.h, palette: doc.palette.slice(),
    layers: [{ name: 'Layer 1', visible: true, locked: false, opacity: 100, frames: doc.frames.map((f) => decodeFrame(f, n)) }],
    ms: doc.frames.map(() => null), tags: [], frame: 0, layer: 0, named: 1, sel: null, clip: null,
    fg: doc.palette[0] || '#000000', bg: null, swatch: doc.palette.length ? 0 : -1, liveSwatch: false, reduceN: 8, reduceFrom: null, tm: null,
    undo: [], redo: [], note: '', edits: 0,
    tool: 'brush', size: 1, round: true, perfect: false, symX: false, symY: false, strength: 12, global: false, filled: false,
    brush: null, target: 'fg', outlineMode: 'tinted', darkness: 65, anchor: null, pivotMode: false,
    fps: 8, playing: false, playAt: 0, playTag: -1, onion: false, onionBack: 1, onionFwd: 0,
    drag: null, last: null, hover: null, zoom: 0, top: 0, tile3: false, left: 0, backdrop: BACKDROPS.indexOf('blank'), grid: false,
    picker: true, pick: [0, 0, 0], pickDrag: null, help: false, more: false, tab: 'colour', seen: 0,
    tileSize: tileSizes(doc).includes(8) ? 8 : tileSizes(doc).filter((t) => t <= 16).pop() || 0,
  }
}

const frameMs = (st: State, f: number) => st.ms[f] || Math.round(1000 / st.fps)
const wrap = (st: State, x: number, y: number): Pt => (st.tile3 ? [((x % st.w) + st.w) % st.w, ((y % st.h) + st.h) % st.h] : [x, y])

// ── painting ──
function symPts(st: State, x: number, y: number): Pt[] {
  const pts: Pt[] = [[x, y]]
  if (st.symX) pts.push([st.w - 1 - x, y])
  if (st.symY) pts.push([x, st.h - 1 - y])
  if (st.symX && st.symY) pts.push([st.w - 1 - x, st.h - 1 - y])
  return pts
}
// The canvas cells a point paints: its mirrors, wrapped in the tiled view, inside the selection.
function targets(st: State, x: number, y: number): number[] {
  const out: number[] = []
  for (const p of symPts(st, x, y)) {
    const [px, py] = wrap(st, p[0], p[1])
    if (px < 0 || py < 0 || px >= st.w || py >= st.h || (st.sel && !inSel(st.sel, px, py))) continue
    out.push(py * st.w + px)
  }
  return out
}
function put(st: State, c: number[], x: number, y: number, v: number | ((old: number, k: number) => number), orig?: Map<number, number>) {
  for (const k of targets(st, x, y)) {
    if (orig && !orig.has(k)) orig.set(k, c[k]!)
    c[k] = typeof v === 'function' ? v(c[k]!, k) : v
  }
}
const bgIndex = (st: State) => (st.bg ? ensureColor(st, st.bg) : -1)

// A stretch of a stroke on a state whose cel and palette are copies (edit.html stroke): the brush
// (or the custom brush) at each point of the line, mirrored, clipped to the selection.
function strokeSeg(st: State, d: Paint, x0: number, y0: number, x1: number, y1: number) {
  const c = cel(st), t = st.tool
  if (t === 'brush' && st.brush) {
    const b = st.brush
    for (const [lx, ly] of lineCells(x0, y0, x1, y1)) for (const p of b.cells) {
      put(st, c, lx + p.dx - (b.w >> 1), ly + p.dy - (b.h >> 1), d.right ? -1 : ensureColor(st, p.hex), d.orig)
    }
    return
  }
  const v = t === 'brush' ? (d.right ? bgIndex(st) : ensureColor(st, st.fg)) : -1
  const amt = st.strength / 100
  // Each pixel shades once a stroke: crossing it again does nothing.
  const shade = (old: number, k: number) => {
    if (old < 0 || d.shaded.has(k)) return old
    d.shaded.add(k)
    return ensureColor(st, shiftHex(st.palette[old]!, d.right ? amt : -amt))
  }
  const perfect = t === 'brush' && st.perfect && st.size === 1
  for (const [lx, ly] of lineCells(x0, y0, x1, y1)) {
    for (const [x, y] of brushCells(lx, ly, st.size, st.round)) put(st, c, x, y, t === 'shade' ? shade : v, d.orig)
    if (!perfect) continue
    // Pixel-perfect: an L-shaped corner loses its middle pixel (Aseprite's freehand mode).
    const tr = d.trail, end = tr[tr.length - 1]
    if (end && end[0] === lx && end[1] === ly) continue
    tr.push([lx, ly])
    if (tr.length < 3) continue
    const [ax, ay] = tr[tr.length - 3]!, [bx, by] = tr[tr.length - 2]!
    if (Math.abs(ax - lx) === 1 && Math.abs(ay - ly) === 1 && Math.abs(ax - bx) + Math.abs(ay - by) === 1 && Math.abs(lx - bx) + Math.abs(ly - by) === 1) {
      for (const k of targets(st, bx, by)) if (d.orig.has(k)) c[k] = d.orig.get(k)!
      tr.splice(tr.length - 2, 1)
    }
  }
}

function shapeTargets(st: State, d: Shape): number[] {
  const kind = st.tool === 'rect' ? 'rect' : st.tool === 'ellipse' ? 'ellipse' : 'line'
  const out = new Set<number>()
  for (const [x, y] of shapeCells(kind, st.filled, d.x0, d.y0, d.x1, d.y1)) for (const k of targets(st, x, y)) out.add(k)
  return [...out]
}

// Lines and shapes are 1px, mirrored, inside the selection (edit.html commitShape).
function commitShape(st: State, d: Shape): State {
  const next = editable(snapshot(st), true), c = cel(next)
  const v = d.right ? bgIndex(next) : ensureColor(next, st.fg)
  for (const k of shapeTargets(st, d)) c[k] = v
  return { ...next, drag: null, last: [d.x1, d.y1] }
}

// Bucket fill (edit.html fill): the 4-connected run of one colour on the current layer, or with
// Global every pixel of it, inside the selection; right-click fills with transparency.
function fill(st: State, x: number, y: number, right: boolean): State {
  const src = cel(st), k0 = y * st.w + x, target = src[k0]!
  const next = editable(snapshot(st), true), c = cel(next)
  const repl = right ? -1 : ensureColor(next, st.fg)
  if (target === repl) return st
  const ok = (k: number) => !st.sel || inSel(st.sel, k % st.w, Math.floor(k / st.w))
  if (st.global) {
    let n = 0
    for (let k = 0; k < c.length; k++) if (src[k] === target && ok(k)) { c[k] = repl; n++ }
    return { ...next, note: `Global fill: ${n} px of ${target < 0 ? 'transparent' : st.palette[target]}.` }
  }
  const seen = new Set([k0]), stack = [k0]
  while (stack.length) {
    const k = stack.pop()!
    if (!ok(k)) continue
    c[k] = repl
    const px = k % st.w, py = (k - px) / st.w
    for (const [nx, ny] of [[px + 1, py], [px - 1, py], [px, py + 1], [px, py - 1]] as Pt[]) {
      const nk = ny * st.w + nx
      if (nx >= 0 && ny >= 0 && nx < st.w && ny < st.h && !seen.has(nk) && src[nk] === target) { seen.add(nk); stack.push(nk) }
    }
  }
  return { ...next, note: '' }
}

// The eyedropper: the colour on screen (every visible layer); right-click takes the background.
function pick(st: State, x: number, y: number, toBg: boolean): State {
  const v = composite(st, st.frame, true)[y * st.w + x]!
  if (v < 0) return toBg ? { ...st, bg: null, note: 'Background set to transparent.' } : { ...st, note: 'Nothing there to pick (transparent).' }
  const hex = st.palette[v]!
  return toBg ? { ...st, bg: hex, note: `Picked ${hex} as the background.` } : { ...st, fg: hex, swatch: v, note: `Picked ${hex}.` }
}

// The custom brush: the selected pixels as they show (edit.html brushFromSel).
function brushFromSel(st: State): State {
  const s = st.sel
  if (!s) return { ...st, note: 'Select an area first (Select, Wand or Lasso), then Ctrl+B.' }
  const g = composite(st, st.frame, true), cells: Brush['cells'] = []
  for (let j = 0; j < s.h; j++) for (let i = 0; i < s.w; i++) {
    const x = s.x + i, y = s.y + j
    if (x < 0 || y < 0 || x >= st.w || y >= st.h || !inSel(s, x, y)) continue
    const v = g[y * st.w + x]!
    if (v >= 0) cells.push({ dx: i, dy: j, hex: st.palette[v]! })
  }
  if (!cells.length) return { ...st, note: 'The selection is empty: nothing to make a brush of.' }
  return { ...deselect(st), brush: { w: s.w, h: s.h, cells }, tool: 'brush', note: `Custom brush ${s.w}x${s.h} (${cells.length} px): the brush stamps it; ✕ clears it.` }
}

// ── selection transforms ──
// The 4 corner pixels of a selection 3x3 or bigger scale it; the 2x2 just outside each corner turns it.
function handleAt(s: Sel, x: number, y: number): { kind: 'scale' | 'rotate'; corner: Corner } | null {
  const x1 = s.x + s.w - 1, y1 = s.y + s.h - 1
  const cx = x === s.x ? 'w' : x === x1 ? 'e' : '', cy = y === s.y ? 'n' : y === y1 ? 's' : ''
  if (s.w >= 3 && s.h >= 3 && cx && cy) return { kind: 'scale', corner: (cy + cx) as Corner }
  const ox = x < s.x && x >= s.x - 2 ? 'w' : x > x1 && x <= x1 + 2 ? 'e' : '', oy = y < s.y && y >= s.y - 2 ? 'n' : y > y1 && y <= y1 + 2 ? 's' : ''
  return ox && oy ? { kind: 'rotate', corner: (oy + ox) as Corner } : null
}

// A floating selection stretched by one corner to (x, y), nearest neighbour (edit.html resizeSelTo / dropScaled).
function scaled(b: Sel, corner: Corner, x: number, y: number): Sel {
  const right = b.x + b.w, bottom = b.y + b.h, cap = 128
  let nx = b.x, ny = b.y, nw: number, nh: number
  if (corner[1] === 'e') nw = Math.max(1, Math.min(cap, x - b.x + 1))
  else { nw = Math.min(cap, right - Math.min(x, right - 1)); nx = right - nw }
  if (corner[0] === 's') nh = Math.max(1, Math.min(cap, y - b.y + 1))
  else { nh = Math.min(cap, bottom - Math.min(y, bottom - 1)); ny = bottom - nh }
  const float = resample(b.float!, b.w, b.h, nw, nh)
  const mask = b.mask ? resample(b.mask.map(Number), b.w, b.h, nw, nh).map(Boolean) : null
  return { x: nx, y: ny, w: nw, h: nh, mask, float, pv: null }
}

// A floating selection turned by `ang` around its pivot, sampled per canvas cell (edit.html rotMap).
function rotated(b: Sel, ang: number, st: State): Sel | null {
  const [pvx, pvy] = pivot(b), cells = new Map<number, number>()
  rotMap(b.w, b.h, b.x, b.y, pvx, pvy, ang, st.w, st.h, (x, y, i, j) => {
    if (!b.mask || b.mask[j * b.w + i]) cells.set(y * st.w + x, b.float![j * b.w + i]!)
  })
  const s = selFromCells(new Set(cells.keys()), st, b.pv)
  if (!s) return null
  const float = new Array<number>(s.w * s.h).fill(-1)
  for (const [k, v] of cells) { const x = k % st.w, y = (k - x) / st.w; float[(y - s.y) * s.w + x - s.x] = v }
  return { ...s, float }
}

// Where the pointer is, in pixels with the fraction kept (the rotation's angle needs it).
function pointAt(ev: ClientPointerEvent, g: Geo): Pt {
  const fx = ev.fine ? ev.fine.x : ev.x + 0.5, fy = ev.fine ? ev.fine.y : ev.y + 0.5
  return g.half ? [fx, g.top * 2 + fy * 2] : [fx / (g.cw || 2 * g.z) + (g.left || 0), g.top + fy / g.z]
}

// The selection as it shows: mid-scale or mid-turn, the transformed float.
function shownSel(st: State): Sel | null {
  const d = st.drag
  if (d && (d.kind === 'scale' || d.kind === 'rotate')) return d.to
  return st.sel
}

// ── pointer ──
function onPointer(surface: ClientSurface<State>, ev: ClientPointerEvent) {
  const st = surface.state, g = geometry.get(surface)
  if (!st || !g || ev.type === 'enter') return
  if (onPicker(surface, st, ev)) return
  const pal = paletteAt.get(surface)
  if (pal && ev.type === 'down' && !st.drag) {
    const i = swatchAt(ev, pal.top, pal.count, pal.cols)
    if (i >= 0) return surface.setState(pickSwatchAs(st, i, ev.button === 'right' ? 'bg' : st.target))
  }
  const o = overviewAt.get(surface)
  if (o && ev.type === 'down' && !st.drag && ev.y >= o.top && ev.y < o.top + o.height) {
    // Centre the view on the column pressed.
    const col = Math.floor(ev.x / o.pw) * o.step
    surface.setState({ ...st, left: Math.max(0, Math.min((g.across || 0) - g.span, col - Math.floor(g.span / 2))) })
    return
  }
  const set = (s: State) => surface.setState(s)
  const d = st.drag
  if (ev.type === 'up' || ev.type === 'leave') {
    // The region holds the pointer from a down to its up; only a plain stroke ends on leaving.
    if (d && (ev.type === 'up' || d.kind === 'paint')) set(finish(st, d))
    else if (ev.type === 'leave' && st.hover) set({ ...st, hover: null })
    return
  }
  const tile = st.tile3 && 3 * st.w <= (surface.columns || Infinity)
  const view = tile ? { ...st, tile3: true } : { ...st, tile3: false }
  const dims = tile ? { w: st.w * 3, h: st.h * 3 } : st
  if (ev.type === 'move') {
    if (!d || !ev.button) {
      const p = ev.y >= 0 && ev.y < g.rows ? pixelAt(ev, g, dims, false) : null
      const hv = p ? wrap(view, p[0], p[1]) : null
      if (hv?.[0] !== st.hover?.[0] || hv?.[1] !== st.hover?.[1]) set({ ...st, hover: hv })
      return
    }
    const [x, y] = wrap(view, ...pixelAt(ev, g, dims, true)!)
    if (d.kind === 'paint') {
      if (x === d.x && y === d.y) return
      const next = editable({ ...st, tile3: tile }, true)
      strokeSeg(next, d, d.x, d.y, x, y)
      set({ ...next, tile3: st.tile3, drag: { ...d, x, y }, hover: [x, y] })
    } else if (d.kind === 'shape' || d.kind === 'marquee') {
      if (x !== d.x1 || y !== d.y1) set({ ...st, drag: { ...d, x1: x, y1: y } })
    } else if (d.kind === 'lasso') {
      const end = d.pts[d.pts.length - 1]!
      if (end[0] !== x || end[1] !== y) set({ ...st, drag: { ...d, pts: d.pts.concat(lineCells(end[0], end[1], x, y).slice(1)) } })
    } else if (d.kind === 'move') {
      const s = st.sel, nx = x - d.dx, ny = y - d.dy
      if (s && (nx !== s.x || ny !== s.y)) set({ ...st, sel: { ...s, x: nx, y: ny, pv: s.pv ? [s.pv[0] + nx - s.x, s.pv[1] + ny - s.y] : null } })
    } else if (d.kind === 'scale') {
      const to = scaled(d.base, d.corner, x, y)
      if (to.x !== d.to.x || to.y !== d.to.y || to.w !== d.to.w || to.h !== d.to.h) set({ ...st, drag: { ...d, to } })
    } else if (d.kind === 'rotate') {
      const [px, py] = pointAt(ev, g), [cx, cy] = pivot(d.base)
      let ang = Math.atan2(py - cy, px - cx) - d.a0
      if (ev.shift) ang = Math.round(ang / (Math.PI / 12)) * (Math.PI / 12)
      const deg = Math.round((ang * 180) / Math.PI)
      if (deg !== d.deg) set({ ...st, drag: { ...d, deg, to: rotated(d.base, ang, st) } })
    } else if (d.kind === 'stamp') {
      const next = stampTile(st, x, y, d.right, false)
      if (next !== st) set(next)
    } else if (d.kind === 'layer') {
      const next = { ...st, layers: st.layers.slice() }, L = next.layers[st.layer]!, frames = L.frames.slice()
      frames[st.frame] = d.base
      next.layers[st.layer] = { ...L, frames }
      set(shiftLayer(next, x - d.x0, y - d.y0))
    }
    return
  }
  // down
  if (ev.y < 0 || ev.y >= g.rows) return
  const raw = pixelAt(ev, g, dims, false)
  if (!raw) return
  if (st.playing) return play(surface, false)
  const [x, y] = wrap(view, raw[0], raw[1])
  const right = ev.button === 'right' || ev.button === 'middle', t = st.tool
  if (ev.alt && !SELECTS.has(t)) return set(pick(st, x, y, right))
  const L = st.layers[st.layer]!
  const mutating = PAINTS.has(t) || SHAPES.has(t) || t === 'fill' || t === 'move' || t === 'stamp'
  if (mutating && L.locked) return set({ ...st, note: locked(st) })
  if (mutating && !L.visible) return set({ ...st, note: `${L.name} is hidden: show it to draw on it.` })
  if (PAINTS.has(t)) {
    const next = editable(snapshot(stamp({ ...st, tile3: tile })), true)
    const dr: Paint = { kind: 'paint', right, x, y, trail: [], orig: new Map(), shaded: new Set() }
    if (ev.shift && st.last && t !== 'shade') strokeSeg(next, dr, st.last[0], st.last[1], x, y)
    else strokeSeg(next, dr, x, y, x, y)
    return set({ ...next, tile3: st.tile3, drag: dr, note: '', hover: [x, y] })
  }
  if (SHAPES.has(t)) return set({ ...stamp(st), drag: { kind: 'shape', right, x0: x, y0: y, x1: x, y1: y }, note: '' })
  if (t === 'fill') return set(fill(stamp(st), x, y, right))
  if (t === 'picker') return set(pick(st, x, y, right))
  if (t === 'stamp') return set({ ...stampTile(stamp(st), x, y, right, true), drag: { kind: 'stamp', right } })
  if (t === 'move') {
    const next = editable(snapshot(stamp(st)))
    return set({ ...next, drag: { kind: 'layer', x0: x, y0: y, base: cel(next).slice() }, note: '' })
  }
  if (t === 'wand') {
    const cells = new Set(region(cel(st), st.w, st.h, x, y)), op: Op = right ? 'sub' : ev.shift ? 'add' : 'new'
    const v = cel(st)[y * st.w + x]!, next = applySel(st, cells, op), ns = next.sel
    const what = `Wand: ${op === 'sub' ? 'took away' : 'selected'} ${cells.size} px of ${v < 0 ? 'transparent' : st.palette[v]}`
    return set({ ...next, note: `${what} · ${ns ? `sel ${ns.w}x${ns.h} at ${ns.x},${ns.y}` : 'nothing selected'}.` })
  }
  if (t === 'lasso') return set({ ...st, drag: { kind: 'lasso', op: right ? 'sub' : ev.shift ? 'add' : 'new', pts: [[x, y]] }, note: '' })
  // The Select tool.
  const s = st.sel
  if (st.pivotMode && s) {
    const [px, py] = pointAt(ev, g)
    return set({ ...st, sel: { ...s, pv: tile ? [x + 0.5, y + 0.5] : [px, py] }, pivotMode: false, note: 'Pivot set: turn the selection from just outside a corner.' })
  }
  if (right) return set(s ? { ...st, drag: { kind: 'marquee', op: 'sub', x0: x, y0: y, x1: x, y1: y }, note: '' } : st)
  if (s) {
    const hd = handleAt(s, x, y)
    if (hd || inSel(s, x, y)) {
      if (L.locked) return set({ ...st, note: locked(st) })
      if (hd) {
        const next = s.float ? st : lift(snapshot(st)), base = next.sel!
        if (hd.kind === 'scale') return set({ ...next, drag: { kind: 'scale', corner: hd.corner, base, to: base }, note: '' })
        const [px, py] = pointAt(ev, g), [cx, cy] = pivot(base)
        return set({ ...next, drag: { kind: 'rotate', base, a0: Math.atan2(py - cy, px - cx), to: base, deg: 0 }, note: '' })
      }
      const next = s.float ? st : lift(snapshot(st), !!(ev.ctrl || ev.alt))
      return set({ ...next, drag: { kind: 'move', dx: x - s.x, dy: y - s.y }, note: '' })
    }
  }
  set({ ...st, drag: { kind: 'marquee', op: ev.shift ? 'add' : 'new', x0: x, y0: y, x1: x, y1: y }, note: '' })
}

function finish(st: State, d: Drag): State {
  const done = { ...st, drag: null }
  if (d.kind === 'paint') return { ...done, last: st.tool === 'shade' ? st.last : [d.x, d.y] }
  if (d.kind === 'shape') return commitShape(st, d)
  if (d.kind === 'marquee') {
    if (d.op === 'new' && d.x0 === d.x1 && d.y0 === d.y1) return deselect(done)
    return applySel(done, rectCells(st, d.x0, d.y0, d.x1, d.y1), d.op)
  }
  if (d.kind === 'lasso') return d.pts.length < 3 ? done : applySel(done, new Set(lassoCells(d.pts, st.w, st.h)), d.op)
  if (d.kind === 'scale') return { ...done, sel: d.to, note: `Scaled to ${d.to.w}x${d.to.h}.` }
  if (d.kind === 'rotate') return d.to ? { ...done, sel: d.to, note: `Turned ${d.deg}° around the pivot.` } : { ...done, sel: d.base }
  return done
}

// ── keys ──
const ARROWS: Record<string, Pt> = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }

function setTool(st: State, tool: Tool): State {
  if (tool === st.tool && (tool === 'rect' || tool === 'ellipse')) return { ...st, filled: !st.filled, note: '' }
  // The selection stays (painting keeps inside it); floating pixels are set down.
  return { ...stamp(st), tool, pivotMode: false, note: '' }
}

function onKey(surface: ClientSurface<State>, k: ClientKeyEvent) {
  const st = surface.state
  if (!st) return
  const set = (s: State) => surface.setState(s)
  const key = k.key.toLowerCase()
  if (k.ctrl || k.meta) {
    if (key === 'z') set(restore(st, k.shift ? 'redo' : 'undo'))
    else if (key === 'y') set(restore(st, 'redo'))
    else if (key === 's') save(surface)
    else if (key === 'c') set(copy(st))
    else if (key === 'x') set(cut(st))
    else if (key === 'v') set({ ...paste(st), tool: st.clip ? 'select' : st.tool })
    else if (key === 'a') set({ ...selectAll(st), tool: SELECTS.has(st.tool) ? st.tool : 'select' })
    else if (key === 'd') set({ ...deselect(st), note: '' })
    else if (key === 'b') set(brushFromSel(st))
    return
  }
  if (k.shift && key === 'h') return set(transform(st, 'h'))
  if (k.shift && key === 'v') return set(transform(st, 'v'))
  if (k.shift && key === 'n') return set(layerOp(st, 'add'))
  if (k.shift && key === 'u') return set(setTool(st, 'ellipse'))
  if (key === ' ' || key === 'space') return play(surface, !st.playing)
  if (key === 'return' || key === 'enter') return set(st.sel && st.sel.float ? { ...stamp(st), note: 'Set down.' } : deselect(st))
  if ((key === 'delete' || key === 'backspace') && st.sel) return set(clear(st))
  const tool = key.length === 1 ? KEYS[key] : undefined
  if (tool) return set(setTool(st, tool))
  if (key === 'x') return set(swapColors(st))
  if (key === '[' || key === ']') return set({ ...st, size: Math.max(1, Math.min(8, st.size + (key === '[' ? -1 : 1))) })
  if (key === '0') return set({ ...st, zoom: 0 })
  if (/^[1-5]$/.test(key)) return set({ ...st, zoom: [0.5, 1, 2, 3, 4][Number(key) - 1]! })
  if (key === '+' || key === '=' || key === '-') return zoom(surface, key === '-' ? -1 : 1)
  if (k.shift && (key === 'left' || key === 'right')) {
    const g = geometry.get(surface)
    if (g) scrollX(surface, (key === 'left' ? -1 : 1) * Math.max(1, Math.floor(g.span / 2)))
    return
  }
  const arrow = ARROWS[key]
  if (arrow && st.sel && SELECTS.has(st.tool)) return set(nudge(st, arrow[0], arrow[1]))
  if (key === 'left' || key === 'right') {
    const n = frameCount(st)
    if (n > 1) set(goFrame(st, (st.frame + (key === 'left' ? n - 1 : 1)) % n))
    return
  }
  if (key === 'up' || key === 'down' || key === 'pageup' || key === 'pagedown') {
    const g = geometry.get(surface)
    if (g) scroll(surface, (key.startsWith('page') ? Math.max(1, g.bands - 1) : 1) * (key.endsWith('up') ? -1 : 1))
  }
}

function scroll(surface: ClientSurface<State>, by: number) {
  const st = surface.state, g = geometry.get(surface)
  if (!st || !g || g.bands >= g.total) return
  surface.setState({ ...st, top: Math.max(0, Math.min(g.total - g.bands, g.top + by)) })
}

// Across a picture wider than the pane (full-size pixels, never half blocks on the desktop).
function scrollX(surface: ClientSurface<State>, by: number) {
  const st = surface.state, g = geometry.get(surface)
  if (!st || !g || g.half || !g.across || g.span >= g.across) return
  surface.setState({ ...st, left: Math.max(0, Math.min(g.across - g.span, (g.left || 0) + by)) })
}

function zoom(surface: ClientSurface<State>, dir: number) {
  const st = surface.state, g = geometry.get(surface)
  if (!st || !g) return
  surface.setState({ ...st, zoom: zoomStep(g, dir, g.sideways) })
}

// ── playback ──
// Steps through the frames (or a tag's) at each frame's own timing; the frame shown moves, the
// frame being edited stays (edit.html playToggle).
function play(surface: ClientSurface<State>, on: boolean, tag = -1) {
  const st = surface.state
  if (!st) return
  timers.get(surface)?.()
  timers.delete(surface)
  if (!on) return surface.setState({ ...st, playing: false, playTag: -1, note: '' })
  if (frameCount(st) < 2) return surface.setState({ ...st, playing: false, note: 'Add a second frame to play an animation.' })
  const t = tag >= 0 ? st.tags[tag] : undefined, a = t ? t.from : 0, b = t ? t.to : frameCount(st) - 1
  const arm = (s: State, i: number) => {
    const stop = surface.every(frameMs(s, i), () => {
      stop()
      const cur = surface.state
      if (!cur || !cur.playing) return
      const n = i >= b || i + 1 >= frameCount(cur) ? a : i + 1
      const next = { ...cur, playAt: n }
      surface.setState(next)
      arm(next, n)
    })
    timers.set(surface, stop)
  }
  const next = { ...stamp(st), playing: true, playAt: a, playTag: tag, drag: null, note: '' }
  surface.setState(next)
  arm(next, a)
}

// ── saving and exporting ──
function art(st: State) {
  const s = stamp(st)
  return { w: s.w, h: s.h, palette: s.palette, frames: Array.from({ length: frameCount(s) }, (_, f) => encodeFrame(composite(s, f, false))) }
}

// Sends the visible layers flattened, floating pixels included, one string per frame, with each
// frame's timing and the tags.
function save(surface: ClientSurface<State>) {
  const st = surface.state
  if (!st) return
  const n = frameCount(st)
  surface.post({
    type: 'save', ...art(st),
    ms: n > 1 ? st.ms.map((_, f) => frameMs(st, f)) : null,
    tags: st.tags.map((t) => ({ name: t.name, from: t.from, to: t.to })),
  })
  const hidden = st.layers.some((L) => !L.visible)
  surface.setState({ ...st, note: 'Put in your prompt - press Enter to send it to Claude.' + (hidden ? ' Hidden layers were left out.' : '') })
}

// A tileset's tile, back to the tile editor: the frame on screen, flattened.
function sendBack(surface: ClientSurface<State>) {
  const st = surface.state
  if (!st) return
  const s = stamp(st)
  surface.post({ type: 'back', w: s.w, h: s.h, palette: s.palette, frames: [encodeFrame(composite(s, st.frame, false))] })
  surface.setState({ ...st, note: 'Back in the tile editor: Apply tile there keeps it.' })
}

// Asks the plugin to write a file; the layers go along for Aseprite while they fit one message.
function exportAs(surface: ClientSurface<State>, format: string) {
  const st = surface.state
  if (!st) return
  const n = frameCount(st)
  if ((format === 'sheet' || format === 'frames') && n < 2) return surface.setState({ ...st, note: `${format === 'sheet' ? 'A sheet' : 'Frames'} needs 2+ frames: use PNG for one image.` })
  const s = stamp(st), shown = s.layers.filter((L) => L.visible)
  const layers = format === 'ase' && shown.length > 1 && shown.length * n * s.w * s.h < 80_000
    ? shown.map((L) => ({ name: L.name, frames: L.frames.map(encodeFrame) })) : null
  surface.post({ type: 'export', format, frame: st.frame, ...art(st), ms: st.ms.map((_, f) => frameMs(st, f)), layers })
  surface.setState({ ...st, note: 'Writing…' })
}

// ── drawing ──
type Mark = 0 | typeof EDGE | typeof HANDLE | typeof PIVOT

// What each pixel shows: layers at their opacity, the floating and transformed pixels, a shape
// being dragged, the selection's edge and handles, and the onion skin under transparent pixels.
function looks(st: State, frame: number): Look {
  const N = st.w * st.h, col: (string | null)[] = new Array(N).fill(null), dim: boolean[] = new Array(N).fill(false)
  const s = shownSel(st), d = st.drag
  st.layers.forEach((L, li) => {
    if (!L.visible || L.opacity <= 0) return
    let g = L.frames[frame]!
    if (li === st.layer && !st.playing && ((s && s.float) || (d && d.kind === 'shape'))) {
      g = g.slice()
      if (s && s.float) for (let j = 0; j < s.h; j++) for (let i = 0; i < s.w; i++) {
        const v = s.float[j * s.w + i]!, x = s.x + i, y = s.y + j
        if (v >= 0 && x >= 0 && y >= 0 && x < st.w && y < st.h) g[y * st.w + x] = v
      }
      // A shape being dragged: -3 the foreground, -2 the background, -1 erasing.
      if (d && d.kind === 'shape') { const v = d.right ? (st.bg ? -2 : -1) : -3; for (const k of shapeTargets(st, d)) g[k] = v }
    }
    for (let i = 0; i < N; i++) {
      const v = g[i]!
      if (v === -1) continue
      const hex = v === -3 ? st.fg : v === -2 ? st.bg! : st.palette[v]!
      if (L.opacity >= 100) { col[i] = hex; dim[i] = false }
      else if (col[i]) col[i] = mixHex(col[i]!, hex, L.opacity / 100)
      else { col[i] = hex; dim[i] = true }
    }
  })
  const mark = new Array<Mark>(N).fill(0)
  if (s && !st.playing) {
    for (let j = 0; j < s.h; j++) for (let i = 0; i < s.w; i++) {
      const x = s.x + i, y = s.y + j
      if (x < 0 || y < 0 || x >= st.w || y >= st.h || !inSel(s, x, y)) continue
      if (!inSel(s, x - 1, y) || !inSel(s, x + 1, y) || !inSel(s, x, y - 1) || !inSel(s, x, y + 1)) mark[y * st.w + x] = EDGE
    }
    if (st.tool === 'select' && s.w >= 3 && s.h >= 3) {
      for (const [x, y] of [[s.x, s.y], [s.x + s.w - 1, s.y], [s.x, s.y + s.h - 1], [s.x + s.w - 1, s.y + s.h - 1]] as Pt[]) {
        if (x >= 0 && y >= 0 && x < st.w && y < st.h) mark[y * st.w + x] = HANDLE
      }
    }
    if (st.tool === 'select' && (s.pv || (d && d.kind === 'rotate'))) {
      const [px, py] = pivot(d && d.kind === 'rotate' ? d.base : s), x = Math.floor(px), y = Math.floor(py)
      if (x >= 0 && y >= 0 && x < st.w && y < st.h) mark[y * st.w + x] = PIVOT
    }
  }
  if (d && d.kind === 'marquee') {
    const x0 = Math.min(d.x0, d.x1), x1 = Math.max(d.x0, d.x1), y0 = Math.min(d.y0, d.y1), y1 = Math.max(d.y0, d.y1)
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (x === x0 || x === x1 || y === y0 || y === y1) mark[y * st.w + x] = EDGE
  }
  if (d && d.kind === 'lasso') for (const [x, y] of d.pts) mark[y * st.w + x] = EDGE
  let ghost: (string | null)[] | null = null
  const n = frameCount(st)
  if (st.onion && !st.playing && n > 1) {
    const gh: (string | null)[] = new Array(N).fill(null)
    const lay = (off: number, tint: string) => {
      const f = (((frame + off) % n) + n) % n
      if (f === frame) return
      const g = composite(st, f, false)
      for (let i = 0; i < N; i++) if (g[i]! >= 0) gh[i] = tint
    }
    // Farthest first, so the nearest frames show on top.
    for (let k = Math.min(st.onionBack, n - 1); k >= 1; k--) lay(-k, BACK)
    for (let k = Math.min(st.onionFwd, n - 1); k >= 1; k--) lay(k, FWD)
    ghost = gh
  }
  const W = st.w, H = st.h, tile = st.tile3
  return (X, Y) => {
    const x = tile ? X % W : X, y = tile ? Y % H : Y, i = y * W + x
    const centre = !tile || (X >= W && X < 2 * W && Y >= H && Y < 2 * H)
    const c = col[i], m = centre ? mark[i]! : 0
    if (m === HANDLE) return [HANDLE, c || ACCENT]
    if (m === PIVOT) return [PIVOT, ACCENT]
    if (m === EDGE) return c ? [EDGE, c] : [EDGE_EMPTY, ACCENT]
    if (c) return [dim[i] ? GHOST : SOLID, c]
    const o = ghost ? ghost[i] : null
    return o ? [GHOST, o] : [EMPTY, undefined]
  }
}

// The picker's hue, saturation and value: those of the colour being set (the foreground, or the
// background while BG is the target), keeping the last hue while that colour is a grey.
const pickHsv = (st: State): [number, number, number] => pickFor(st.target === 'bg' ? st.bg : st.fg, st.pick)

// A press at step x of the square's row y, or of the hue strip, sets the colour as a swatch does.
function pickAt(st: State, x: number, y: number | 'hue'): State {
  const [h, s, v] = pickStep(pickHsv(st), x, y)
  const hex = hsvHex(h, s, v), next: State = { ...st, pick: [h, s, v], note: '' }
  if (st.target === 'bg') return { ...next, bg: hex }
  return { ...setFg(next, hex), tool: st.tool === 'eraser' || st.tool === 'picker' ? 'brush' : st.tool }
}

// Swatch i as the foreground (the brush comes back from the eraser or picker) or as the background.
function pickSwatchAs(st: State, i: number, as: 'fg' | 'bg'): State {
  const hex = st.palette[i]!, tool = st.tool === 'eraser' || st.tool === 'picker' ? 'brush' : st.tool
  return as === 'bg' ? { ...st, bg: hex, note: '' } : { ...st, fg: hex, swatch: i, tool, note: '' }
}

// A press or drag on the picker; false when the pointer is not the picker's.
function onPicker(surface: ClientSurface<State>, st: State, ev: ClientPointerEvent): boolean {
  const top = pickerTop.get(surface)
  if (ev.type === 'up' || ev.type === 'leave') {
    if (!st.pickDrag) return false
    surface.setState({ ...st, pickDrag: null })
    return true
  }
  if (st.pickDrag && top !== undefined && ev.type === 'move' && ev.button) {
    const x = Math.floor(ev.fine ? ev.fine.x : ev.x)
    surface.setState({ ...pickAt(st, x, st.pickDrag === 'hue' ? 'hue' : ev.y - top), pickDrag: st.pickDrag })
    return true
  }
  if (top === undefined || ev.type !== 'down' || st.drag) return false
  const hit = pickerHit(ev, top)
  if (!hit) return false
  surface.setState({ ...pickAt(st, hit.x, hit.y), pickDrag: hit.on })
  return true
}

function lint(st: State): string {
  const used = new Set(composite(st, st.frame, true).filter((v) => v >= 0)).size
  return `${used} colour${used === 1 ? '' : 's'} in use · ${st.palette.length} in the palette`
}

const Editor: ClientModule<Props, State> = (props, surface) => {
  const { Box, Text, Input, Select } = surface.elements
  const Button = chips(surface.elements, props.surface === 'desktop')
  let st = surface.state
  if (!st || st.rev !== props.doc.rev) {
    if (!st) {
      surface.onPointer((ev) => onPointer(surface, ev))
      surface.onKey((k) => onKey(surface, k))
    }
    timers.get(surface)?.()
    timers.delete(surface)
    st = fromDoc(props.doc)
    if (props.notice) st.seen = props.notice.id
    surface.setState(st)
  } else if (props.notice && props.notice.id !== st.seen) {
    st = { ...st, seen: props.notice.id, note: props.notice.text }
    surface.setState(st)
  }
  const cols = surface.columns || props.cols
  const tile = st.tile3 && 3 * st.w <= cols
  const dw = tile ? 3 * st.w : st.w, dh = tile ? 3 * st.h : st.h
  // The desktop reports the pointer by whole cells, so it never draws half blocks: a sprite too wide for
  // the pane keeps full-size pixels and scrolls across. Its cells are tall, so its pixels are drawn a
  // fraction of a cell wider than two columns, to be square (pixels.tsx fit).
  const boxes = props.surface === 'desktop'
  // Under the canvas, never taking rows from it, so switching tabs doesn't change the zoom.
  const showPicker = st.picker && st.tab === 'colour'
  const f = fit({ w: dw, h: dh, zoom: st.zoom }, cols, props.rows, boxes, boxes)
  const top = Math.max(0, Math.min(f.total - f.visible, st.top))
  const span = f.half ? dw : f.span, left = Math.max(0, Math.min(dw - span, st.left))
  const n = frameCount(st), shownFrame = st.playing ? Math.min(st.playAt, n - 1) : st.frame
  // The desktop draws the grid as hairlines over the pixels, the terminal as a tint (pixels.tsx).
  const lined = st.grid && boxes && !f.half, across = span < dw, look = looks({ ...st, tile3: tile }, shownFrame)
  const drawn = canvas(look, dw, dh, f, top, surface.elements,
    CANVAS_BUDGET - (lined ? GRID_LINE_COST * (span + f.visible + 2) : 0) - (showPicker ? PICKER_BUDGET : 0) - (across && boxes ? OVERVIEW_BUDGET : 0) -
      CHIP_COST * Math.min(st.palette.length, PALETTE_SHOWN),
    { backdrop: st.backdrop, grid: st.grid && !boxes, boxes, left })
  const g: Geo = { ...f, top, left, across: dw, sideways: boxes, bands: drawn.bands, rows: drawn.bands * f.bandRows }
  geometry.set(surface, g)
  const grid = lined ? gridLines(surface.elements, g, span) : []
  // Under the canvas, in rows the pointer can find: the overview of a sprite wider than the pane (desktop),
  // then the colour picker.
  const ov = across && boxes ? overview(look, dw, dh, cols, left, span, surface.elements) : null
  if (ov) overviewAt.set(surface, { top: g.rows + 1, height: ov.height, pw: ov.pw, step: ov.step })
  else overviewAt.delete(surface)
  const picker = showPicker ? pickerRows(surface.elements, boxes, pickHsv(st)) : null
  const underCanvas = g.rows + 1 + (ov ? ov.height + 1 : 0)
  if (picker) pickerTop.set(surface, underCanvas)
  else pickerTop.delete(surface)
  const scrolls = g.bands < g.total
  const set = (fn: (s: State) => State) => () => { if (surface.state) surface.setState(fn(surface.state)) }
  const L = st.layers[st.layer]!, nl = st.layers.length, s = st.sel, t = st.tool, tm = tilemap(st)
  const chip = (hex: string | null) => (hex ? <Text color={hex}>██</Text> : <Text dimColor>··</Text>)
  const fgAt = st.palette.indexOf(st.fg), bgAt = st.bg ? st.palette.indexOf(st.bg) : -1
  const pickSwatch = (i: number) => set((x) => pickSwatchAs(x, i, x.target))
  // The palette's chips, in rows under the picker (or the canvas); a press anywhere on one picks it.
  const swatches: Swatch[] = st.palette.slice(0, PALETTE_SHOWN).map((c, i) => {
    const mark = i === fgAt ? '[]' : i === bgAt ? '()' : i === st!.swatch ? '{}' : ''
    return { hex: c, label: mark ? `${mark[0]}${i + 1}${mark[1]}` : `${i + 1}`, lit: i === fgAt, onPress: pickSwatch(i) }
  })
  const paletteRows = swatchRows(surface.elements, boxes, swatches, cols)
  paletteAt.set(surface, { top: picker ? underCanvas + PICK_H + 2 : underCanvas, count: swatches.length, cols })
  const hsv = (ch: 'h' | 's' | 'v', by: number) => set((x) => {
    if (x.target === 'fg') return nudgeHsv(x, ch, by)
    if (!x.bg) return { ...x, note: 'The background is transparent: pick a colour for it first.' }
    return { ...x, bg: nudgeHsv({ ...x, fg: x.bg, liveSwatch: false }, ch, by).fg, note: '' }
  })
  const mirrors = [
    <Button key="sym-x" label="Mirror X" variant={st.symX ? 'primary' : 'secondary'} onPress={set((x) => ({ ...x, symX: !x.symX }))} />,
    <Button key="sym-y" label="Mirror Y" variant={st.symY ? 'primary' : 'secondary'} onPress={set((x) => ({ ...x, symY: !x.symY }))} />,
  ]
  const sizeCtl = [
    <Text key="size">size {st.size}</Text>,
    <Button key="size-dn" label="‹" onPress={set((x) => ({ ...x, size: Math.max(1, x.size - 1) }))} />,
    <Button key="size-up" label="›" onPress={set((x) => ({ ...x, size: Math.min(8, x.size + 1) }))} />,
    <Button key="shape" label={st.round ? 'Round' : 'Square'} onPress={set((x) => ({ ...x, round: !x.round }))} />,
  ]
  const selOps = [
    <Button key="copy" label="Copy" onPress={set(copy)} />,
    <Button key="cut" label="Cut" onPress={set(cut)} />,
    <Button key="paste" label="Paste" onPress={set((x) => ({ ...paste(x), tool: x.clip ? 'select' : x.tool }))} />,
    <Button key="clear" label="Delete" onPress={set(clear)} />,
    <Button key="deselect" label="Deselect" onPress={set((x) => ({ ...deselect(x), note: '' }))} />,
    <Button key="crop" label="Crop" onPress={set(cropToSel)} />,
    <Button key="to-brush" label="To brush" onPress={set(brushFromSel)} />,
    <Button key="flip-h" label="Flip ↔" onPress={set((x) => transform(x, 'h'))} />,
    <Button key="flip-v" label="Flip ↕" onPress={set((x) => transform(x, 'v'))} />,
    <Button key="rot90" label="Rotate 90°" onPress={set((x) => transform(x, 'rot'))} />,
  ]
  const pivotBtn = <Button key="pivot" label="Pivot" variant={st.pivotMode ? 'primary' : 'secondary'}
    onPress={set((x) => (x.sel ? { ...x, pivotMode: !x.pivotMode, note: x.pivotMode ? '' : 'Click where the selection should turn around.' } : { ...x, note: NO_SEL }))} />
  const options = PAINTS.has(t)
    ? [...sizeCtl,
      ...(t === 'brush' && st.size === 1 ? [<Button key="perfect" label="Pixel-perfect" variant={st.perfect ? 'primary' : 'secondary'} onPress={set((x) => ({ ...x, perfect: !x.perfect }))} />] : []),
      ...(t === 'shade' ? [<Text key="strength">strength {st.strength}%</Text>,
        <Button key="str-dn" label="‹" onPress={set((x) => ({ ...x, strength: Math.max(4, x.strength - 4) }))} />,
        <Button key="str-up" label="›" onPress={set((x) => ({ ...x, strength: Math.min(40, x.strength + 4) }))} />] : []),
      ...mirrors,
      ...(t === 'brush' && st.brush ? [<Button key="brush-clear" label={`brush ${st.brush.w}x${st.brush.h} ✕`} onPress={set((x) => ({ ...x, brush: null, note: '' }))} />] : [])]
    : t === 'fill' ? [<Button key="global" label="Global" variant={st.global ? 'primary' : 'secondary'} onPress={set((x) => ({ ...x, global: !x.global }))} />]
    : SHAPES.has(t) ? [...(t === 'line' ? [] : [<Button key="filled" label={st.filled ? 'Filled' : 'Outline'} onPress={set((x) => ({ ...x, filled: !x.filled }))} />]), ...mirrors]
    : SELECTS.has(t) ? [...selOps, ...(t === 'select' ? [pivotBtn] : [])]
    : []
  const toolName = (tl: Tool) => (TOOLS.find(([k]) => k === tl) || [tl, 'Stamp'])[1]
  const toolChip = (tl: Tool) => <Button key={`t-${tl}`} label={toolName(tl)} variant={t === tl ? 'primary' : 'secondary'} onPress={set((x) => setTool(x, tl))} />
  const sizeInput = (key: string, label: string, placeholder: string, submitLabel: string, apply: (x: State, w: number, h: number) => State) => (
    <Input key={key} label={label} placeholder={placeholder} submitLabel={submitLabel} onSubmit={(value) => {
      const x = surface.state
      if (!x) return
      const sz = parseSize(value)
      surface.setState(sz ? apply(x, sz[0], sz[1]) : { ...x, note: `"${value.trim()}" isn't a size like 32 or 20x30 (1-64).` })
    }} />
  )
  let tabBody
  if (st.tab === 'colour') {
    tabBody = [
      <Box key="col-a" flexWrap="wrap" columnGap={1}>
        <Box key="fg">{chip(st.fg)}<Button key="target-fg" label={` FG ${st.fg}`} variant={st.target === 'fg' ? 'primary' : 'secondary'} onPress={set((x) => ({ ...x, target: 'fg' }))} /></Box>
        <Box key="bg">{chip(st.bg)}<Button key="target-bg" label={` BG ${st.bg || 'none'}`} variant={st.target === 'bg' ? 'primary' : 'secondary'} onPress={set((x) => ({ ...x, target: 'bg' }))} /></Box>
        <Button key="picker" label="Picker" variant={st.picker ? 'primary' : 'secondary'}
          onPress={set((x) => ({ ...x, picker: !x.picker, pickDrag: null, pick: pickHsv(x), note: x.picker ? 'The picker is hidden; press Picker to show it again.' : `The picker under the canvas sets the ${x.target === 'bg' ? 'background' : 'foreground'}: the square is saturation and brightness, the strip under it the hue.` }))} />
        <Button key="swap" label="Swap" onPress={set(swapColors)} />
        <Button key="bg-none" label="No background" onPress={set((x) => ({ ...x, bg: null, note: 'Background set to transparent.' }))} />
        <Button key="col-more" label={st.more ? 'Fewer' : 'More'} variant={st.more ? 'primary' : 'secondary'} onPress={set((x) => ({ ...x, more: !x.more }))} />
      </Box>,
      <Box key="col-b" flexWrap="wrap" columnGap={1}>
        <Input key="hex" label="Colour " placeholder="#rrggbb" submitLabel="set" onSubmit={(value) => {
          const x = surface.state
          if (!x) return
          const v = value.trim().toLowerCase().replace(/^([0-9a-f]{6})$/, '#$1')
          if (!/^#[0-9a-f]{6}$/.test(v)) return surface.setState({ ...x, note: `"${value.trim()}" isn't a colour like #a1b2c3.` })
          surface.setState(x.target === 'bg' ? { ...x, bg: v, note: '' } : setFg(x, v))
        }} />
        <Button key="pal-add" label="Add to palette" onPress={set(palAdd)} />
        <Text key="lint" dimColor>{lint(st)}</Text>
      </Box>,
      // More: nudging hue, saturation and brightness, editing a swatch in place, the palette's own tools.
      ...(st.more || st.reduceFrom ? [
        <Box key="col-hsv" flexWrap="wrap" columnGap={1}>
          <Text dimColor>hue</Text>
          <Button key="h-dn" label="H-" onPress={hsv('h', -15)} />
          <Button key="h-up" label="H+" onPress={hsv('h', 15)} />
          <Text dimColor>saturation</Text>
          <Button key="s-dn" label="S-" onPress={hsv('s', -0.1)} />
          <Button key="s-up" label="S+" onPress={hsv('s', 0.1)} />
          <Text dimColor>brightness</Text>
          <Button key="v-dn" label="V-" onPress={hsv('v', -0.1)} />
          <Button key="v-up" label="V+" onPress={hsv('v', 0.1)} />
        </Box>,
        <Box key="col-pal" flexWrap="wrap" columnGap={1}>
          <Button key="pal-remove" label="Remove swatch" onPress={set(palRemove)} />
          <Button key="live" label="Edit swatch" variant={st.liveSwatch ? 'primary' : 'secondary'}
            onPress={set((x) => ({ ...x, liveSwatch: !x.liveSwatch, target: 'fg', note: x.liveSwatch ? '' : x.swatch >= 0 ? `Colour changes now rewrite swatch ${x.swatch + 1} everywhere.` : 'Click a swatch first.' }))} />
          <Button key="pal-sort" label="Sort" onPress={set(palSort)} />
          <Button key="db32" label="DB32 palette" onPress={set(loadDB32)} />
        </Box>,
        <Box key="col-c" flexWrap="wrap" columnGap={1}>
          <Button key="reduce" label={`Reduce to ${st.reduceN} colours`} onPress={set(palReduce)} />
          <Button key="reduce-dn" label="‹" onPress={set((x) => ({ ...x, reduceN: Math.max(2, x.reduceN - 1) }))} />
          <Button key="reduce-up" label="›" onPress={set((x) => ({ ...x, reduceN: Math.min(64, x.reduceN + 1) }))} />
          {st.reduceFrom && <Button key="reduce-keep" label="Keep" variant="primary" onPress={set(palKeep)} />}
          {st.reduceFrom && <Button key="reduce-revert" label="Revert" onPress={set(palRevert)} />}
        </Box>,
      ] : []),
    ]
  } else if (st.tab === 'canvas') {
    const anchor = st.anchor || suggestAnchor(st)
    tabBody = [
      <Box key="cv-a" flexWrap="wrap" columnGap={1}>
        {sizeInput('canvas-size', 'Canvas ', `${st.w}x${st.h}`, 'resize, no scaling', (x, w, h) => ({ ...canvasSize(x, w, h, x.anchor || suggestAnchor(x)), anchor: null }))}
        <Select key="anchor" label="anchor " value={anchor === 'fit' ? 'fit' : String(anchor[1] * 3 + anchor[0])}
          options={[...ANCHORS.map((a, i) => ({ value: String(i), label: a })), { value: 'fit', label: 'centre the content' }]}
          onSelect={(v) => { const x = surface.state; if (x) surface.setState({ ...x, anchor: v === 'fit' ? 'fit' : [Number(v) % 3, Math.floor(Number(v) / 3)] }) }} />
      </Box>,
      <Box key="cv-b" flexWrap="wrap" columnGap={1}>
        {sizeInput('resample', 'Resample ', '32 or 20x30', 'scale', resampleTo)}
        <Button key="trim" label="Trim" onPress={set(trim)} />
        <Button key="crop-cv" label="Crop to selection" onPress={set(cropToSel)} />
        <Button key="flip-h-cv" label="Flip ↔" onPress={set((x) => transform(x, 'h'))} />
        <Button key="flip-v-cv" label="Flip ↕" onPress={set((x) => transform(x, 'v'))} />
        <Button key="rot90-cv" label="Rotate 90°" onPress={set((x) => transform(x, 'rot'))} />
      </Box>,
      <Box key="cv-c" flexWrap="wrap" columnGap={1}>
        <Button key="outline" label="Outline" onPress={set((x) => celTool(x, 'outline', x.outlineMode, x.darkness))} />
        <Select key="outline-mode" value={st.outlineMode} options={[{ value: 'tinted', label: 'dark-tinted' }, { value: 'black', label: 'black' }, { value: 'white', label: 'white' }]}
          onSelect={(v) => { const x = surface.state; if (x) surface.setState({ ...x, outlineMode: v as State['outlineMode'] }) }} />
        {st.outlineMode === 'tinted' && <Text key="dark">darkness {st.darkness}</Text>}
        {st.outlineMode === 'tinted' && <Button key="dark-dn" label="‹" onPress={set((x) => ({ ...x, darkness: Math.max(20, x.darkness - 5) }))} />}
        {st.outlineMode === 'tinted' && <Button key="dark-up" label="›" onPress={set((x) => ({ ...x, darkness: Math.min(95, x.darkness + 5) }))} />}
        {CEL_TOOLS.map(([c, label]) => <Button key={c} label={label} onPress={set((x) => celTool(x, c, x.outlineMode, x.darkness))} />)}
      </Box>,
      <Box key="cv-d" flexWrap="wrap" columnGap={1}>
        <Button key="tile3" label="Tile 3x3" variant={st.tile3 ? 'primary' : 'secondary'}
          onPress={set((x) => (x.tile3 || 3 * x.w <= cols ? { ...x, tile3: !x.tile3, note: x.tile3 ? '' : 'Tiled 3x3: painting wraps around the edges.' } : { ...x, note: `Tile 3x3 needs ${3 * x.w} columns: widen the pane.` }))} />
        <Button key="backdrop" label={`Backdrop: ${BACKDROPS[st.backdrop]}`} onPress={set((x) => ({ ...x, backdrop: (x.backdrop + 1) % BACKDROPS.length }))} />      </Box>,
    ]
  } else if (st.tab === 'layers') {
    const sizes = tileSizes(st)
    const order = st.layers.map((_, i) => st!.layers.length - 1 - i)
    tabBody = [
      <Box key="ly-a" flexWrap="wrap" columnGap={1}>
        {order.map((i) => {
          const Ly = st!.layers[i]!, flags = [Ly.visible ? '' : 'hidden', Ly.locked ? 'locked' : '', Ly.opacity < 100 ? `${Ly.opacity}%` : ''].filter(Boolean).join(' ')
          return <Button key={`layer-${i}`} label={Ly.name + (flags ? ` (${flags})` : '')} variant={i === st!.layer ? 'primary' : 'secondary'} onPress={set((x) => pickLayer(x, i))} />
        })}
      </Box>,
      <Box key="ly-b" flexWrap="wrap" columnGap={1}>
        <Button key="layer-add" label="+ Layer" onPress={set((x) => layerOp(x, 'add'))} />
        <Button key="layer-hide" label={L.visible ? 'Hide' : 'Show'} onPress={set((x) => layerOp(x, 'hide'))} />
        <Button key="layer-lock" label={L.locked ? 'Unlock' : 'Lock'} onPress={set((x) => layerOp(x, 'lock'))} />
        <Text key="opacity">opacity {L.opacity}%</Text>
        <Button key="op-dn" label="‹" onPress={set((x) => layerSet(x, { opacity: Math.max(0, x.layers[x.layer]!.opacity - 10) }))} />
        <Button key="op-up" label="›" onPress={set((x) => layerSet(x, { opacity: Math.min(100, x.layers[x.layer]!.opacity + 10) }))} />
        {nl > 1 && <Button key="layer-up" label="Raise" onPress={set((x) => layerOp(x, 'up'))} />}
        {nl > 1 && <Button key="layer-down" label="Lower" onPress={set((x) => layerOp(x, 'down'))} />}
        {nl > 1 && <Button key="layer-merge" label="Merge down" onPress={set((x) => layerOp(x, 'merge'))} />}
        {nl > 1 && <Button key="layer-del" label="Delete" onPress={set((x) => layerOp(x, 'del'))} />}
      </Box>,
      <Input key="layer-name" label="Rename " placeholder={L.name} submitLabel="rename" onSubmit={(value) => {
        const x = surface.state
        if (x && value.trim()) surface.setState(layerSet(x, { name: value.trim().slice(0, 32) }))
      }} />,
      tm ? (
        <Box key="ly-tm" flexWrap="wrap" columnGap={1}>
          <Text key="tm-info" dimColor>tilemap {tm.ts}px:</Text>
          {tm.tiles.slice(1, 33).map((_, i) => (
            <Button key={`tile-${i + 1}`} label={`#${i + 1}`} variant={tm.pick === i + 1 ? 'primary' : 'secondary'}
              onPress={set((x) => (x.tm ? { ...x, tm: { ...x.tm, pick: i + 1 }, tool: 'stamp', note: '' } : x))} />
          ))}
          {tm.tiles.length > 33 && <Text key="tm-more" dimColor>+{tm.tiles.length - 33}</Text>}
          <Button key="tm-flatten" label="Flatten" onPress={set((x) => ({ ...x, tm: null, tool: x.tool === 'stamp' ? 'brush' : x.tool, note: 'Back to plain pixels.' }))} />
          {tilePreview(tm.tiles[tm.pick]!, tm.ts)}
        </Box>
      ) : (
        <Box key="ly-tm" flexWrap="wrap" columnGap={1}>
          {sizes.length > 0 && <Select key="tile-size" label="Tilemap of " value={String(st.tileSize)} options={sizes.map((ts) => ({ value: String(ts), label: `${ts}x${ts} tiles` }))}
            onSelect={(v) => { const x = surface.state; if (x) surface.setState({ ...x, tileSize: Number(v) }) }} />}
          {sizes.length > 0 && <Button key="tm-make" label="Make tilemap" onPress={set((x) => toTilemap(x, x.tileSize))} />}
          {!sizes.length && <Text key="tm-none" dimColor>No tile size divides {st.w}x{st.h} for a tilemap.</Text>}
        </Box>
      ),
    ]
  } else if (st.tab === 'frames') {
    tabBody = [
      <Box key="fr-a" flexWrap="wrap" columnGap={1}>
        {n > 1 && <Button key="prev" label="<" onPress={set((x) => goFrame(x, (x.frame + frameCount(x) - 1) % frameCount(x)))} />}
        <Text key="frame">frame {shownFrame + 1}/{n}</Text>
        {n > 1 && <Button key="next" label=">" onPress={set((x) => goFrame(x, (x.frame + 1) % frameCount(x)))} />}
        <Button key="frame-add" label="+ Frame" onPress={set((x) => frameOp(x, 'add'))} />
        <Button key="frame-dup" label="Duplicate" onPress={set((x) => frameOp(x, 'dup'))} />
        {n > 1 && <Button key="frame-del" label="Delete" onPress={set((x) => frameOp(x, 'del'))} />}
        {n > 1 && <Button key="frame-left" label="Move <" onPress={set((x) => frameOp(x, 'left'))} />}
        {n > 1 && <Button key="frame-right" label="Move >" onPress={set((x) => frameOp(x, 'right'))} />}
      </Box>,
      <Box key="fr-b" flexWrap="wrap" columnGap={1}>
        {n > 1 && <Button key="play" label={st.playing ? 'Stop' : 'Play'} variant={st.playing ? 'primary' : 'secondary'} onPress={() => play(surface, !surface.state?.playing)} />}
        <Text key="fps">{st.fps} fps</Text>
        <Button key="fps-dn" label="‹" onPress={set((x) => ({ ...x, fps: Math.max(1, x.fps - 1) }))} />
        <Button key="fps-up" label="›" onPress={set((x) => ({ ...x, fps: Math.min(24, x.fps + 1) }))} />
        <Input key="ms" label="This frame " placeholder={st.ms[st.frame] ? `${st.ms[st.frame]} ms` : `${frameMs(st, st.frame)} ms (fps)`} submitLabel="set ms (empty: fps)"
          onSubmit={(value) => { const x = surface.state; if (x) surface.setState(setMs(x, value)) }} />
        {n > 1 && <Button key="onion" label="Onion" variant={st.onion ? 'primary' : 'secondary'} onPress={set((x) => ({ ...x, onion: !x.onion }))} />}
        {n > 1 && st.onion && <Button key="onion-back" label={`‹${st.onionBack}`} onPress={set((x) => ({ ...x, onionBack: (x.onionBack + 1) % 4 }))} />}
        {n > 1 && st.onion && <Button key="onion-fwd" label={`${st.onionFwd}›`} onPress={set((x) => ({ ...x, onionFwd: (x.onionFwd + 1) % 4 }))} />}
      </Box>,
      <Box key="fr-c" flexWrap="wrap" columnGap={1}>
        {st.tags.map((tg, i) => (
          <Box key={`tagged-${i}`}>
            <Text color={tg.color}>▶</Text>
            <Button key={`tag-${i}`} label={` ${tg.name} ${tg.from + 1}-${tg.to + 1}`} variant={st!.playing && st!.playTag === i ? 'primary' : 'secondary'}
              onPress={() => { const x = surface.state; if (x) play(surface, !(x.playing && x.playTag === i), i) }} />
          </Box>
        ))}
        {st.tags.map((tg, i) => <Button key={`untag-${i}`} label={`✕ ${tg.name}`} dimColor onPress={set((x) => delTag(x, i))} />)}
        <Input key="tag" label="Tag " placeholder={`walk 1-${n}`} submitLabel="add tag" onSubmit={(value) => { const x = surface.state; if (x) surface.setState(addTag(x, value)) }} />
      </Box>,
    ]
  } else {
    tabBody = [
      <Box key="ex-a" flexWrap="wrap" columnGap={1}>
        {EXPORTS.map(([fmt, label]) => <Button key={`export-${fmt}`} label={label} onPress={() => exportAs(surface, fmt)} />)}
      </Box>,
      <Text key="ex-b" dimColor wrap="wrap">
        PNG at 1x or 8x, a sheet of every frame in a row, a looping GIF, each frame as an 8x PNG, Aseprite (layers and frames) or the text grid: written beside the sprite, never over a file that is there. Send to Claude hands the pixels to Claude.
      </Text>,
    ]
  }
  function tilePreview(tile: number[], ts: number) {
    if (ts > 16) return null
    const look: Look = (x, y) => (tile[y * ts + x]! >= 0 ? [SOLID, st!.palette[tile[y * ts + x]!]] : [EMPTY, undefined])
    const pf = { half: true, z: 1, bandRows: 1, total: Math.ceil(ts / 2), visible: Math.ceil(ts / 2), span: ts }
    return <Box key="tm-preview" flexDirection="column">{canvas(look, ts, ts, pf, 0, surface.elements, 4000).rows}</Box>
  }
  const mirror = st.symX || st.symY ? ` · mirror ${st.symX ? 'X' : ''}${st.symY ? 'Y' : ''}` : ''
  const selInfo = s ? ` · sel ${s.w}x${s.h} at ${s.x},${s.y}${s.mask ? ` (${selCount(s)} px)` : ''}${s.float ? ' floating' : ''}` : ''
  const cell = st.hover ? ` · ${st.hover[0]},${st.hover[1]}` : ''
  const colourInfo = t === 'eraser' || SELECTS.has(t) || t === 'move' ? '' : ` ${st.fg}`

  return (
    <Box flexDirection="column">
      <Box key="canvas" flexDirection="column">{drawn.rows}{grid}</Box>
      {ov && <Box key="overview" flexDirection="column" marginTop={1} height={ov.height} overflow="hidden">{ov.rows}</Box>}
      {picker && <Box key="picker" flexDirection="column" marginTop={1}>{picker}</Box>}
      <Box key="palette" flexDirection="column" marginTop={1}>
        {paletteRows}
        {st.palette.length > PALETTE_SHOWN && <Text dimColor>{`+${st.palette.length - PALETTE_SHOWN} more (Pick takes any)`}</Text>}
        {!st.palette.length && <Text dimColor>No colours yet: set one under Colour.</Text>}
      </Box>
      {/* Tools in groups (paint, shapes, select); then what the chosen one does and its options. */}
      <Box key="tools" flexWrap="wrap" columnGap={2} marginTop={1}>
        {colourNow(surface.elements, boxes, t === 'eraser' ? null : st.fg)}
        {TOOL_GROUPS.map((grp, gi) => (
          <Box key={`tools-${gi}`} flexWrap="wrap" columnGap="xs">
            {grp.map(toolChip)}
            {gi === TOOL_GROUPS.length - 1 && tm && toolChip('stamp')}
          </Box>
        ))}
      </Box>
      <Text key="tool-help" dimColor wrap="wrap">{`${toolName(t)}${TOOL_KEY[t] ? ` (${TOOL_KEY[t]})` : ''}: ${TOOL_HELP[t]}`}</Text>
      {options.length > 0 && <Box key="opts" flexWrap="wrap" columnGap={1}>{options}</Box>}
      {/* History, view and the way out; then the panels. */}
      <Box key="main" flexWrap="wrap" columnGap={2} marginTop={1}>
        <Box key="out" columnGap="xs">
          {props.doc.back && <Button key="back" label="Back to tiles" variant="primary" onPress={() => sendBack(surface)} />}
          <Button key="save" label="Send to Claude" variant={props.doc.back ? 'secondary' : 'primary'} onPress={() => save(surface)} />
        </Box>
        <Box key="history" columnGap="xs">
          <Button key="undo" label="Undo" onPress={set((x) => restore(x, 'undo'))} />
          <Button key="redo" label="Redo" onPress={set((x) => restore(x, 'redo'))} />
        </Box>
        <Box key="view" columnGap="xs">
          <Button key="zoom-out" label="-" onPress={() => zoom(surface, -1)} />
          <Button key="zoom-in" label="+" onPress={() => zoom(surface, 1)} />
          <Button key="grid" label="Grid" variant={st.grid ? 'primary' : 'secondary'} onPress={set((x) => ({ ...x, grid: !x.grid }))} />
          {scrolls && <Button key="up" label="▲" onPress={() => scroll(surface, -Math.max(1, g.bands - 1))} />}
          {scrolls && <Button key="down" label="▼" onPress={() => scroll(surface, Math.max(1, g.bands - 1))} />}
          {across && <Button key="left" label="◀" onPress={() => scrollX(surface, -Math.max(1, Math.floor(span / 2)))} />}
          {across && <Button key="right" label="▶" onPress={() => scrollX(surface, Math.max(1, Math.floor(span / 2)))} />}
        </Box>
        <Button key="help" label="Keys" variant={st.help ? 'primary' : 'secondary'} onPress={set((x) => ({ ...x, help: !x.help }))} />
      </Box>
      {st.help && <Box key="keys" flexDirection="column">{SHORTCUTS.map((line, i) => <Text key={`keys-${i}`} dimColor wrap="wrap">{line}</Text>)}</Box>}
      <Box key="tabs" flexWrap="wrap" columnGap="xs" marginTop={1}>
        {TABS.map(([tb, name]) => (
          <Button key={`tab-${tb}`} label={tb === 'frames' && n > 1 ? `${name} ${shownFrame + 1}/${n}` : tb === 'layers' && nl > 1 ? `${name} ${st!.layer + 1}/${nl}` : name}
            variant={st!.tab === tb ? 'primary' : 'secondary'} onPress={set((x) => ({ ...x, tab: tb }))} />
        ))}
      </Box>
      <Box key="tab" flexDirection="column">{tabBody}</Box>
      <Text key="status" dimColor wrap="truncate-end">
        {st.note || `${t}${colourInfo} · ${st.w}x${st.h}${g.half ? ' · half blocks' : g.z > 1 ? ` · ${g.z}x` : ''}${mirror}${selInfo}${cell}` +
          rowsShown(g, dh) + (across ? ` · columns ${left + 1}-${left + span} of ${dw} (${ov ? 'click the overview, ' : ''}Shift+Left/Right)` : '') + ' · Ctrl+Z undo'}
      </Text>
    </Box>
  )
}

export default Editor
