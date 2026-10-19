// The tile editor's region of its pane: a Client module like the pixel editor's (editor.tsx), for
// a tileset as SpriteForge's TILES window edits one (app/project.html): a 16-tile Wang set
// (wang.ts) or a 49-tile platformer set. It has two views.
//
// The overview. For a Wang set, a few terrain cells drawn with the set the way a game draws it,
// one tile on each cell corner (the dual grid), flat, as walls or isometric: "Paint map" paints and
// clears cells to see the tiles chain; "Edit pixels" (flat only) draws on the map itself, each
// stroke landing in the tile under it, so every repeat of that tile follows. Big tiles show at
// 1/2 or 1/4 scale while painting cells. For a platformer set, its 7x7 sheet: a click opens a
// tile, or "Edit pixels" draws on the sheet.
//
// A tile: one tile, or a Wang set's base texture, drawn large with brush, eraser, fill and pick,
// and Offset ½ to bring the base's seams to the middle. Done on the base derives the edge tiles
// from it again, keeping any drawn by hand. "Open in pixel editor" takes the tile to the pixel
// editor pane, whose "Back to tiles" brings it back here.
import type { ClientKeyEvent, ClientModule, ClientPointerEvent, ClientSurface } from 'claude-code'

import type { TileDoc } from '../types'
import {
  EMPTY, GRID_LINE_COST, OVERVIEW_BUDGET, SHADE, SOLID, canvas, chips, decodeFrame, encodeFrame, fit, flood, gridLines, line, overview, pixelAt,
  rowsShown, zoomStep,
} from './pixels'
import type { Fit, Geo, Look } from './pixels'
import { BASE, CORNERS, QUADS, projectIso, rederive, shadeHex, wallOverlay, wangPlacements } from './wang'

type Tool = 'brush' | 'eraser' | 'fill' | 'pick'
type View = 'flat' | 'wall' | 'iso'
// A tile being edited: its own pixels and undo, until Done puts it in the set.
type Step = { art: number[]; offset: boolean }
type Edit = Step & { mask: number; undo: Step[]; redo: Step[]; tool: Tool; zoom: number; top: number; left: number; base: boolean }
type Snap = { tiles: number[][]; palette: string[] }
type Back = { id: number; mask: number; palette: string[]; art: string }
type State = {
  rev: number
  kind: 'wang' | 'platformer'
  T: number
  palette: string[]
  tiles: number[][]
  prev: (number[] | null)[] // each tile as it was before its last Done, for "Previous version"
  cells: string[] // painted map cells, "x,y"
  mode: 'cells' | 'pixels'
  view: View
  zoom: number // a steps() entry, or 0: the largest that shows 4x3 cells
  top: number
  left: number // first pixel column drawn, when the picture is wider than the pane
  grid: boolean // the pixel grid: hairlines on the desktop, a tint on the terminal
  help: boolean // the shortcut sheet
  color: number
  undo: Snap[]
  redo: Snap[]
  edit: Edit | null
  drag: { erase: boolean; x: number; y: number } | null
  note: string
  sizer: number[] // the base texture the map's size is judged by (plan)
  seen: number // the last tile back from the pixel editor
}
type Props = { doc: TileDoc; cols: number; rows: number; back?: Back | null; surface?: string }
// The map as drawn: its zoom step, map pixels per drawn pixel, cells across and down, and the
// first cell shown (Edit pixels can show fewer cells than were painted, so it centres on them).
type Plan = { step: number; s: number; mw: number; mh: number; ox: number; oy: number }
// What a drawn pixel is: the map (flat or walls: a map pixel every `s`; isometric: an iso pixel
// every `s`, of the W x H flat map), or the platformer sheet.
type Drawn = Geo & { plan: Plan | null; dw: number; dh: number; view: View | 'sheet'; s: number; W: number; H: number }

const UNDO_CAP = 40
const CANVAS_BUDGET = 76_000 // serialized characters for the canvas; the controls take the rest
const PALETTE_SHOWN = 64
const MAX_COLORS = 256
const CELL_SHADE = '#5b6270' // every other empty map cell, so the cells show
const SEED = '#c6ccd2' // a set with no colours gets one, so the brush paints something (project.html _seedEditColor)
// Map zoom steps, smallest first: every 4th or 2nd pixel in half blocks, half blocks, blocks 1-4.
// The desktop reports the pointer by whole cells, so it draws no half blocks (whose lower pixel it
// can't reach): every 8th, 4th or 2nd pixel in blocks, then blocks 1-4.
const STEPS = [-4, -2, 0.5, 1, 2, 3, 4], DESK_STEPS = [-8, -4, -2, 1, 2, 3, 4]
const steps = (sideways: boolean) => (sideways ? DESK_STEPS : STEPS)
// The first step that draws every pixel, where Edit pixels stops zooming out.
const fullStep = (sideways: boolean) => steps(sideways).indexOf(sideways ? 1 : 0.5)
const SHEET = 7 // a platformer set is a 7x7 sheet
const VIEWS: View[] = ['flat', 'wall', 'iso']
const VIEW_LABEL: Record<View, string> = { flat: 'flat', wall: 'walls', iso: 'isometric' }
// PICO-8's 16 colours: offered for adding when the set's own palette lacks them.
const EXTRA = ['#000000', '#1d2b53', '#7e2553', '#008751', '#ab5236', '#5f574f', '#c2c3c7', '#fff1e8',
  '#ff004d', '#ffa300', '#ffec27', '#00e436', '#29adff', '#83769c', '#ff77a8', '#ffccaa']
const TOOLS: [Tool, string][] = [['brush', 'Brush'], ['eraser', 'Eraser'], ['fill', 'Fill'], ['pick', 'Pick']]
const KEYS: Record<string, Tool> = { b: 'brush', p: 'brush', e: 'eraser', g: 'fill', f: 'fill', i: 'pick' }
// The line under the toolbar: the tool or map mode, its key and what it does. Nothing reacts to
// hover inside a desktop pane, so this stands in for tooltips (as in editor.tsx).
const TOOL_KEY: Record<Tool, string> = { brush: 'B', eraser: 'E', fill: 'G', pick: 'I' }
const TOOL_HELP: Record<Tool, string> = {
  brush: 'paints the chosen colour; right-click erases',
  eraser: 'erases to transparent',
  fill: 'fills the area of one colour; right-click fills with transparency',
  pick: 'takes a colour from the tile (a transparent pixel picks the eraser); right-click erases',
}
const SHORTCUTS = [
  'Map: M paint map · P edit pixels · Ctrl+S save to prompt',
  'Tile: B brush · E eraser · G fill · I pick · O offset ½ (the base texture) · Enter done',
  'Both: Ctrl+Z undo · Ctrl+Shift+Z redo · [ and ] colour · + and - zoom · Up / Down and Shift+Left / Right scroll',
]

const geometry = new WeakMap<object, Drawn>()
const plans = new WeakMap<number[], Map<string, Plan>>()
// Where the overview of a wide picture sits (pixels.tsx overview): a press there moves the view.
const overviewAt = new WeakMap<object, { top: number; height: number; pw: number; step: number }>()

// Which cells the map shows and how big: the largest zoom at which enough cells fit both the
// pane and the drawing budget, then (Edit pixels) centred on the painted cells. The budget is
// judged on the base texture repeated over every cell, what a fully painted map costs at most,
// taken from `sizer` (the base as the set opened or as its last Done left it), so painting never
// resizes the map. `sideways`: the desktop's steps (no half blocks).
function plan(st: State, cols: number, rows: number, sideways: boolean): Plan {
  const key = `${st.T} ${cols} ${rows} ${st.mode} ${st.zoom} ${st.palette.length} ${sideways}`
  let cache = plans.get(st.sizer)
  if (!cache) plans.set(st.sizer, (cache = new Map()))
  let p = cache.get(key)
  if (!p) cache.set(key, (p = sizeMap(st, cols, rows, sideways)))
  if (st.mode !== 'pixels' || !st.cells.length) return p
  const xs = st.cells.map((c) => Number(c.split(',')[0])), ys = st.cells.map((c) => Number(c.split(',')[1]))
  const mid = (v: number[], n: number) => Math.max(0, Math.floor((Math.min(...v) + Math.max(...v) + 1 - n) / 2))
  return { ...p, ox: mid(xs, p.mw), oy: mid(ys, p.mh) }
}

function sizeMap(st: State, cols: number, rows: number, sideways: boolean): Plan {
  const T = st.T, base = st.sizer, list = steps(sideways)
  // The columns and rows a map pixel takes: below step 1, every s-th pixel in half blocks (a
  // column, half a row) on the terminal, in blocks (two columns, a row) on the desktop.
  const dims = (step: number): Plan => {
    const s = step < 0 ? -step : 1
    const across = step >= 1 ? 2 * step : (sideways ? 2 : 1) / s, down = step >= 1 ? step : (sideways ? 1 : 0.5) / s
    return { step, s, mw: Math.min(8, Math.floor(cols / (T * across))), mh: Math.min(6, Math.floor(rows / (T * down))), ox: 0, oy: 0 }
  }
  const fits = (d: Plan) => {
    const dw = Math.ceil((d.mw * T) / d.s), dh = Math.ceil((d.mh * T) / d.s)
    const f = fit({ w: dw, h: dh, zoom: d.step < 1 ? 0.5 : d.step }, cols, rows, sideways)
    const look: Look = (x, y) => {
      const v = base[((y * d.s) % T) * T + ((x * d.s) % T)]!
      return v < 0 ? [EMPTY, undefined] : [SOLID, st.palette[v]]
    }
    return canvas(look, dw, dh, f, 0, null, CANVAS_BUDGET, { boxes: sideways }).bands >= Math.min(f.total, f.visible)
  }
  // The most cells at this step, down to minW x minH, that fit; null if even those don't.
  const shrink = (d: Plan, minW: number, minH: number): Plan | null => {
    let mw = d.mw, mh = d.mh
    for (;;) {
      const c = { ...d, mw, mh }
      if (fits(c)) return c
      if (mw <= minW && mh <= minH) return null
      if (mh <= minH || (mw > minW && mw * 6 >= mh * 8)) mw--
      else mh--
    }
  }
  const whole = (d: Plan) => ({ ...d, mw: Math.max(1, d.mw), mh: Math.max(1, d.mh) })
  const pixels = st.mode === 'pixels', low = pixels ? fullStep(sideways) : 0 // pixels are never drawn shrunk
  if (st.zoom && list.indexOf(st.zoom) >= low) {
    const d = whole(dims(st.zoom))
    return shrink(d, 1, 1) || d
  }
  const [minW, minH] = pixels ? [2, 2] : [4, 3]
  for (let i = list.length - 1; i >= low; i--) {
    const d = dims(list[i]!)
    const p = d.mw >= minW && d.mh >= minH ? shrink(d, minW, minH) : null
    if (p) return p
  }
  const d = whole(dims(list[low]!))
  return shrink(d, 1, 1) || d
}

// The platformer sheet: the largest of blocks, half blocks or every 2nd / 4th pixel at which it
// fits the pane (pixels are never shrunk while drawing on it). Sideways (the desktop), every s-th
// pixel is a block, not a half block.
function sheetStep(st: State, cols: number, rows: number, sideways: boolean): { s: number; zoom: number } {
  const W = SHEET * st.T, cw = sideways ? 2 : 1, rh = sideways ? 1 : 2
  if (st.zoom >= 0.5) return { s: 1, zoom: st.zoom }
  for (const z of [4, 3, 2, 1]) if (2 * W * z <= cols && W * z <= rows) return { s: 1, zoom: z }
  for (const s of st.mode === 'pixels' ? [1] : [1, 2, 4, 8]) if (cw * Math.ceil(W / s) <= cols && Math.ceil(W / s / rh) <= rows) return { s, zoom: 0.5 }
  return { s: st.mode === 'pixels' ? 1 : 8, zoom: 0.5 }
}

// A blob of cells in the middle of the map, so it opens showing corners, edges and an inside.
function blob(mw: number, mh: number): string[] {
  const out: string[] = []
  const cx = (mw - 1) / 2, cy = (mh - 1) / 2, rx = Math.max(0.8, mw / 2.6), ry = Math.max(0.8, mh / 2.6)
  for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) {
    if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1) out.push(`${x},${y}`)
  }
  return out
}

function fromDoc(doc: TileDoc, cols: number, rows: number, back: Back | null | undefined, sideways: boolean): State {
  const n = doc.tile * doc.tile, palette = doc.palette.length ? doc.palette.slice() : [SEED]
  const tiles = doc.tiles.map((t) => decodeFrame(t, n))
  const st: State = {
    rev: doc.rev, kind: doc.kind || 'wang', T: doc.tile, palette, tiles,
    prev: new Array<number[] | null>(tiles.length).fill(null), cells: [], mode: 'cells', view: doc.view || 'flat', zoom: 0, top: 0,
    left: 0, grid: false, help: false,
    color: 0, undo: [], redo: [], edit: null, drag: null, note: '', sizer: [], seen: back ? back.id : 0,
  }
  if (st.kind !== 'wang') return st
  st.sizer = st.tiles[BASE]!
  const p = plan(st, cols, rows, sideways)
  return { ...st, cells: blob(p.mw, p.mh) }
}

const cellsOf = (st: State) => {
  const set = new Set(st.cells)
  return (x: number, y: number) => set.has(`${x},${y}`)
}

// The map's pixels: each corner's tile over the ones before it.
function compose(st: State, p: Plan): number[] {
  const T = st.T, W = p.mw * T, H = p.mh * T, out = new Array<number>(W * H).fill(-1)
  for (const q of wangPlacements(cellsOf(st), p.ox, p.oy, p.ox + p.mw - 1, p.oy + p.mh - 1)) {
    const tile = st.tiles[q.mask]!, x0 = Math.round(q.vx * T - T / 2) - p.ox * T, y0 = Math.round(q.vy * T - T / 2) - p.oy * T
    for (let j = 0; j < T; j++) {
      const y = y0 + j
      if (y < 0 || y >= H) continue
      for (let i = 0; i < T; i++) {
        const x = x0 + i, v = tile[j * T + i]!
        if (v >= 0 && x >= 0 && x < W) out[y * W + x] = v
      }
    }
  }
  return out
}

// The tile drawn at map pixel (px, py), counted from cell (0, 0), and which of its pixels: corner tiles split the map
// between them, so the corner nearest the pixel owns it.
function tileAt(st: State, has: (x: number, y: number) => boolean, px: number, py: number): { mask: number; i: number } | null {
  const T = st.T, vx = Math.round(px / T), vy = Math.round(py / T)
  const mask = (has(vx - 1, vy - 1) ? 1 : 0) | (has(vx, vy - 1) ? 2 : 0) | (has(vx - 1, vy) ? 4 : 0) | (has(vx, vy) ? 8 : 0)
  if (!mask) return null
  const fx = px - Math.round(vx * T - T / 2), fy = py - Math.round(vy * T - T / 2)
  return fx >= 0 && fy >= 0 && fx < T && fy < T ? { mask, i: fy * T + fx } : null
}

// A picture of palette indexes (a wall's front face as shadedIndex) drawn every `s`th pixel; empty
// map cells shaded in a checker while painting cells (flat and walls), so the cells show.
function pictureLook(st: State, w: number, px: number[], s: number, cellShade: ((x: number, y: number) => boolean) | null): Look {
  const shades = new Map<number, string>()
  return (x, y) => {
    const v = px[y * s * w + x * s]!
    if (v >= 0) return [SOLID, st.palette[v]]
    if (v <= -2) {
      let c = shades.get(v)
      if (!c) shades.set(v, (c = shadeHex(st.palette[-v - 2] || '#000000')))
      return [SOLID, c]
    }
    return cellShade && cellShade(x * s, y * s) ? [SHADE, CELL_SHADE] : [EMPTY, undefined]
  }
}

// The platformer sheet: tile m at (m % 7, m / 7).
function sheetPixels(st: State): number[] {
  const T = st.T, W = SHEET * T, out = new Array<number>(W * W).fill(-1)
  st.tiles.forEach((t, m) => {
    const ox = (m % SHEET) * T, oy = Math.floor(m / SHEET) * T
    for (let j = 0; j < T; j++) for (let i = 0; i < T; i++) out[(oy + j) * W + ox + i] = t[j * T + i]!
  })
  return out
}

function snapshot(st: State): State {
  return { ...st, undo: st.undo.concat([{ tiles: st.tiles, palette: st.palette }]).slice(-UNDO_CAP), redo: [] }
}

function restore(st: State, from: 'undo' | 'redo'): State {
  const nothing = { ...st, note: from === 'undo' ? 'Nothing to undo.' : 'Nothing to redo.' }
  const e = st.edit
  if (e) {
    const stack = from === 'undo' ? e.undo : e.redo, s = stack[stack.length - 1]
    if (!s) return nothing
    const back = { art: e.art, offset: e.offset }, rest = stack.slice(0, -1)
    return {
      ...st, note: '', drag: null,
      edit: { ...e, ...s, undo: from === 'undo' ? rest : e.undo.concat([back]), redo: from === 'undo' ? e.redo.concat([back]) : rest },
    }
  }
  const stack = from === 'undo' ? st.undo : st.redo, s = stack[stack.length - 1]
  if (!s) return nothing
  const back = { tiles: st.tiles, palette: st.palette }, rest = stack.slice(0, -1)
  return {
    ...st, ...s, note: '', drag: null, color: Math.min(st.color, s.palette.length - 1),
    undo: from === 'undo' ? rest : st.undo.concat([back]),
    redo: from === 'undo' ? st.redo.concat([back]) : rest,
  }
}

// A tile wrapped round by half its size, or (on = false) back again: an odd size shifts by
// floor(T/2) one way and the rest the other, so it lands where it started.
function shifted(art: number[], T: number, on: boolean): number[] {
  const d = on ? Math.floor(T / 2) : T - Math.floor(T / 2), out = new Array<number>(art.length)
  for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) out[((y + d) % T) * T + ((x + d) % T)] = art[y * T + x]!
  return out
}

// `base`: a Wang set's base texture, whose Done derives the edge tiles again; tile 15 picked from
// the tiles is only that tile.
const openTile = (st: State, mask: number, base = false): State => ({
  ...st, drag: null, note: '',
  edit: { mask, art: st.tiles[mask]!.slice(), offset: false, undo: [], redo: [], tool: 'brush', zoom: 0, top: 0, left: 0, base },
})

// Changes the tile being edited, one undo step.
function editArt(st: State, art: number[], offset: boolean): State {
  const e = st.edit!
  return { ...st, note: '', edit: { ...e, art, offset, undo: e.undo.concat([{ art: e.art, offset: e.offset }]).slice(-UNDO_CAP), redo: [] } }
}

function done(st: State): State {
  const e = st.edit
  if (!e) return st
  const art = e.offset ? shifted(e.art, st.T, false) : e.art
  const next = snapshot(st), prev = st.prev.slice()
  prev[e.mask] = st.tiles[e.mask]!
  if (e.base) {
    const r = rederive(st.tiles, st.palette, art, st.T)
    return {
      ...next, tiles: r.tiles, prev, edit: null, drag: null, sizer: art,
      note: r.kept ? `Base texture updated; kept ${r.kept} hand-drawn tile${r.kept === 1 ? '' : 's'} as ${r.kept === 1 ? 'it was' : 'they were'}.` : 'Base texture updated; every tile follows it.',
    }
  }
  const tiles = st.tiles.slice()
  tiles[e.mask] = art
  return { ...next, tiles, prev, edit: null, drag: null, note: '' }
}

// A tile back from the pixel editor: its colours found in (or added to) the set's palette, and
// opened as an undoable change of that tile, for Done or Cancel.
function takeBack(st: State, b: Back): State {
  const n = st.T * st.T, src = decodeFrame(b.art, n)
  if (b.mask < 0 || b.mask >= st.tiles.length || src.length !== n) return { ...st, seen: b.id }
  const palette = st.palette.slice(), map = new Map<number, number>()
  const art = src.map((v) => {
    if (v < 0 || !b.palette[v]) return -1
    let k = map.get(v)
    if (k === undefined) {
      k = palette.indexOf(b.palette[v]!)
      if (k < 0 && palette.length < MAX_COLORS) { palette.push(b.palette[v]!); k = palette.length - 1 }
      if (k < 0) k = 0
      map.set(v, k)
    }
    return k
  })
  const base = st.edit && st.edit.mask === b.mask ? st : openTile({ ...st, edit: null }, b.mask, st.kind === 'wang' && b.mask === BASE && !!(st.edit && st.edit.base))
  const next = editArt({ ...base, palette, seen: b.id }, art, false)
  return { ...next, note: `Tile ${b.mask} is back from the pixel editor: Done keeps it.` }
}

function addColor(st: State, hex: string): State {
  const e = st.edit && st.edit.tool !== 'brush' && st.edit.tool !== 'fill' ? { ...st.edit, tool: 'brush' as Tool } : st.edit
  const at = st.palette.indexOf(hex)
  if (at >= 0) return { ...st, color: at, edit: e, note: '' }
  if (st.palette.length >= MAX_COLORS) return { ...st, note: `The palette is full (${MAX_COLORS} colours).` }
  return { ...st, palette: st.palette.concat([hex]), color: st.palette.length, edit: e, note: '' }
}

function save(surface: ClientSurface<State>) {
  const st = surface.state
  if (!st) return
  surface.post({ type: 'save', tile: st.T, palette: st.palette, tiles: st.tiles.map(encodeFrame) })
  surface.setState({ ...st, note: 'Put in your prompt - press Enter to send it to Claude.' })
}

// The tile being edited, as it stands, to the pixel editor pane.
function toStudio(surface: ClientSurface<State>) {
  const st = surface.state, e = st && st.edit
  if (!st || !e) return
  surface.post({ type: 'studio', mask: e.mask, palette: st.palette, art: encodeFrame(e.offset ? shifted(e.art, st.T, false) : e.art) })
  surface.setState({ ...st, note: `Tile ${e.mask} is in the pixel editor: its "Back to tiles" brings it here.` })
}

// Draws on tiles where they show (a map stroke lands in the tile under it, a sheet stroke in its
// tile); `hit` finds the tile and pixel under a picture pixel.
function strokeTiles(surface: ClientSurface<State>, st: State, ev: ClientPointerEvent, mx: number, my: number,
  hit: (x: number, y: number) => { mask: number; i: number } | null) {
  const erase = ev.button === 'right' || ev.button === 'middle', d = st.drag
  if (ev.type === 'down') {
    const h = hit(mx, my)
    if (erase) {
      const v = h ? st.tiles[h.mask]![h.i]! : -1
      if (v >= 0) surface.setState({ ...st, color: v, note: '' })
      return
    }
    if (!h) return surface.setState({ ...st, note: st.kind === 'wang' ? 'No tile is drawn here: paint some map cells first.' : '' })
  } else if (!d || (mx === d.x && my === d.y)) {
    return
  }
  const base = ev.type === 'down' ? snapshot(st) : st
  const tiles = base.tiles.slice(), copied = new Set<number>()
  line(ev.type === 'move' && d ? d.x : mx, ev.type === 'move' && d ? d.y : my, mx, my, (x, y) => {
    const h = hit(x, y)
    if (!h) return
    if (!copied.has(h.mask)) {
      copied.add(h.mask)
      tiles[h.mask] = tiles[h.mask]!.slice()
    }
    tiles[h.mask]![h.i] = st.color
  })
  surface.setState({ ...base, tiles, drag: { erase: false, x: mx, y: my }, note: '' })
}

function mapPointer(surface: ClientSurface<State>, st: State, p: Plan, ev: ClientPointerEvent, mx: number, my: number) {
  const erase = ev.button === 'right' || ev.button === 'middle', d = st.drag
  if (st.mode === 'cells' || st.view !== 'flat') {
    const cx = Math.floor(mx / st.T), cy = Math.floor(my / st.T)
    if (ev.type === 'move' && d && cx === d.x && cy === d.y) return
    const paint = ev.type === 'move' && d ? !d.erase : !erase
    const set = new Set(st.cells)
    line(ev.type === 'move' && d ? d.x : cx, ev.type === 'move' && d ? d.y : cy, cx, cy, (x, y) => {
      if (x < p.ox || y < p.oy || x >= p.ox + p.mw || y >= p.oy + p.mh) return
      if (paint) set.add(`${x},${y}`)
      else set.delete(`${x},${y}`)
    })
    surface.setState({ ...st, cells: [...set], drag: { erase: !paint, x: cx, y: cy }, note: '' })
    return
  }
  const has = cellsOf(st)
  strokeTiles(surface, st, ev, mx, my, (x, y) => tileAt(st, has, x, y))
}

function sheetPointer(surface: ClientSurface<State>, st: State, ev: ClientPointerEvent, x: number, y: number) {
  const T = st.T, m = Math.floor(y / T) * SHEET + Math.floor(x / T)
  if (st.mode === 'pixels') {
    return strokeTiles(surface, st, ev, x, y, (px, py) => {
      const k = Math.floor(py / T) * SHEET + Math.floor(px / T)
      return k >= 0 && k < st.tiles.length ? { mask: k, i: (py % T) * T + (px % T) } : null
    })
  }
  if (ev.type === 'down' && m >= 0 && m < st.tiles.length) surface.setState(openTile(st, m))
}

function editPointer(surface: ClientSurface<State>, st: State, e: Edit, ev: ClientPointerEvent, x: number, y: number) {
  const T = st.T, d = st.drag
  if (ev.type === 'move') {
    if (!d || (x === d.x && y === d.y)) return
    const art = e.art.slice()
    line(d.x, d.y, x, y, (px, py) => { art[py * T + px] = d.erase ? -1 : st.color })
    surface.setState({ ...st, edit: { ...e, art }, drag: { ...d, x, y } })
    return
  }
  const erase = ev.button === 'right' || ev.button === 'middle' || e.tool === 'eraser'
  if (e.tool === 'pick' && !erase) {
    const v = e.art[y * T + x]!
    surface.setState(v < 0 ? { ...st, edit: { ...e, tool: 'eraser' }, note: '' } : { ...st, color: v, edit: { ...e, tool: 'brush' }, note: '' })
    return
  }
  const art = e.art.slice(), v = erase ? -1 : st.color, fill = e.tool === 'fill' && !erase
  if (fill) flood(art, T, T, y * T + x, v)
  else art[y * T + x] = v
  const next = editArt(st, art, e.offset)
  surface.setState({ ...next, drag: fill ? null : { erase, x, y } })
}

function onPointer(surface: ClientSurface<State>, ev: ClientPointerEvent) {
  const st = surface.state, geo = geometry.get(surface)
  if (!st || !geo || ev.type === 'enter') return
  const o = overviewAt.get(surface)
  if (o && ev.type === 'down' && !st.drag && ev.y >= o.top && ev.y < o.top + o.height) {
    // Centre the view on the column pressed.
    const col = Math.floor(ev.x / o.pw) * o.step, left = Math.max(0, Math.min((geo.across || 0) - geo.span, col - Math.floor(geo.span / 2)))
    surface.setState(st.edit ? { ...st, edit: { ...st.edit, left } } : { ...st, left })
    return
  }
  if (ev.type === 'up' || ev.type === 'leave') {
    if (st.drag) surface.setState({ ...st, drag: null })
    return
  }
  if (ev.type === 'move' && (!st.drag || !ev.button)) return
  if (ev.type === 'down' && (ev.y < 0 || ev.y >= geo.rows)) return
  const at = pixelAt(ev, geo, { w: geo.dw, h: geo.dh }, ev.type === 'move')
  if (!at) return
  if (st.edit) return editPointer(surface, st, st.edit, ev, at[0], at[1])
  if (geo.view === 'sheet') return sheetPointer(surface, st, ev, at[0] * geo.s, at[1] * geo.s)
  const p = geo.plan!
  if (geo.view === 'iso') {
    // Back through the projection to the flat map pixel under the pointer.
    const X = at[0] * geo.s, Y = at[1] * geo.s, half = (X - geo.H) / 2
    const fx = Math.floor(half + Y), fy = Math.floor(Y - half)
    if (fx < 0 || fy < 0 || fx >= geo.W || fy >= geo.H) return
    return mapPointer(surface, st, p, ev, fx + p.ox * st.T, fy + p.oy * st.T)
  }
  mapPointer(surface, st, p, ev, at[0] * p.s + p.ox * st.T, at[1] * p.s + p.oy * st.T)
}

function scroll(surface: ClientSurface<State>, by: number) {
  const st = surface.state, g = geometry.get(surface)
  if (!st || !g || g.bands >= g.total) return
  const top = Math.max(0, Math.min(g.total - g.bands, g.top + by))
  surface.setState(st.edit ? { ...st, edit: { ...st.edit, top } } : { ...st, top })
}

// Across a picture wider than the pane (full-size pixels, never half blocks on the desktop).
function scrollX(surface: ClientSurface<State>, by: number) {
  const st = surface.state, g = geometry.get(surface)
  if (!st || !g || g.half || !g.across || g.span >= g.across) return
  const left = Math.max(0, Math.min(g.across - g.span, (g.left || 0) + by))
  surface.setState(st.edit ? { ...st, edit: { ...st.edit, left } } : { ...st, left })
}

function zoom(surface: ClientSurface<State>, dir: number) {
  const st = surface.state, g = geometry.get(surface)
  if (!st || !g) return
  if (st.edit || g.view === 'sheet') {
    const z = zoomStep(g, dir, g.sideways)
    return surface.setState(st.edit ? { ...st, edit: { ...st.edit, zoom: z } } : { ...st, zoom: z })
  }
  const list = steps(!!g.sideways), low = st.mode === 'pixels' ? fullStep(!!g.sideways) : 0
  const i = Math.max(low, Math.min(list.length - 1, list.indexOf(g.plan!.step) + dir))
  surface.setState({ ...st, zoom: list[i]!, top: 0, left: 0 })
}

const setMode = (st: State, mode: State['mode']): State =>
  mode === 'pixels' && st.view !== 'flat'
    ? { ...st, note: `Edit pixels draws on the flat map: a ${VIEW_LABEL[st.view]} preview doesn't map pixels one to one.` }
    : { ...st, mode, drag: null, top: 0, left: 0, note: '' }

function onKey(surface: ClientSurface<State>, k: ClientKeyEvent) {
  const st = surface.state
  if (!st) return
  const set = (s: State) => surface.setState(s)
  const key = k.key.toLowerCase(), e = st.edit
  if (k.ctrl || k.meta) {
    if (key === 'z') set(restore(st, k.shift ? 'redo' : 'undo'))
    else if (key === 'y') set(restore(st, 'redo'))
    else if (key === 's' && !e) save(surface)
    return
  }
  if (e) {
    const tool = key.length === 1 ? KEYS[key] : undefined
    if (tool) return set({ ...st, edit: { ...e, tool } })
    if (key === 'return' || key === 'enter') return set(done(st))
    if (key === 'o' && e.base) return set(editArt(st, shifted(e.art, st.T, !e.offset), !e.offset))
  } else {
    if (key === 'm') return set(setMode(st, 'cells'))
    if (key === 'p') return set(setMode(st, 'pixels'))
  }
  if (key === '[' || key === ']') {
    const n = st.palette.length
    if (n) set({ ...st, color: ((st.color < 0 ? 0 : st.color) + (key === '[' ? n - 1 : 1)) % n })
    return
  }
  if (key === '+' || key === '=' || key === '-') return zoom(surface, key === '-' ? -1 : 1)
  if (k.shift && (key === 'left' || key === 'right')) {
    const g = geometry.get(surface)
    if (g) scrollX(surface, (key === 'left' ? -1 : 1) * Math.max(1, Math.floor(g.span / 2)))
    return
  }
  if (key === 'up' || key === 'down' || key === 'pageup' || key === 'pagedown') {
    const g = geometry.get(surface)
    if (g) scroll(surface, (key.startsWith('page') ? Math.max(1, g.bands - 1) : 1) * (key.endsWith('up') ? -1 : 1))
  }
}

// The colour a tile shows most, for its button.
function dominant(tile: number[], palette: string[]): string | undefined {
  const count = new Map<number, number>()
  let best = -1, most = 0
  for (const v of tile) {
    if (v < 0) continue
    const c = (count.get(v) || 0) + 1
    count.set(v, c)
    if (c > most) { most = c; best = v }
  }
  return best < 0 ? undefined : palette[best]
}

const cornersOf = (m: number) => CORNERS.filter((_, b) => m & (1 << b))

const Tiles: ClientModule<Props, State> = (props, surface) => {
  const { Box, Text, Input } = surface.elements
  // The desktop reports the pointer by whole cells, so it never draws half blocks: a picture too wide
  // for the pane keeps full-size pixels and scrolls across (pixels.tsx fit).
  const boxes = props.surface === 'desktop'
  const Button = chips(surface.elements, boxes)
  let st = surface.state
  if (!st || st.rev !== props.doc.rev) {
    if (!st) {
      surface.onPointer((ev) => onPointer(surface, ev))
      surface.onKey((k) => onKey(surface, k))
    }
    st = fromDoc(props.doc, props.cols, props.rows, props.back, boxes)
    surface.setState(st)
  } else if (props.back && props.back.id !== st.seen) {
    st = takeBack(st, props.back)
    surface.setState(st)
  }
  const cols = surface.columns || props.cols, T = st.T, e = st.edit
  const set = (fn: (s: State) => State) => () => { if (surface.state) surface.setState(fn(surface.state)) }
  let look: Look, dw: number, dhigh: number, zoomAs: number, top: number, left: number, p: Plan | null = null
  let view: Drawn['view'] = st.kind === 'wang' ? st.view : 'sheet', s = 1, W = 0, H = 0, isoZoom = 0.5
  if (e) {
    const art = e.art
    look = (x, y) => (art[y * T + x]! < 0 ? [EMPTY, undefined] : [SOLID, st!.palette[art[y * T + x]!]])
    dw = dhigh = T
    zoomAs = e.zoom
    top = e.top
    left = e.left
  } else if (st.kind === 'wang') {
    p = plan(st, cols, props.rows, boxes)
    W = p.mw * T
    H = p.mh * T
    const has = cellsOf(st), pl = p
    const shade = st.mode === 'cells' ? (mx: number, my: number) => (Math.floor(mx / T) + pl.ox + Math.floor(my / T) + pl.oy) % 2 === 0 && my < H : null
    if (st.view === 'wall') {
      const walls = wallOverlay((x, y) => has(x + pl.ox, y + pl.oy), p.mw, p.mh, st.tiles[BASE]!, T)
      s = p.s
      look = pictureLook(st, walls.w, walls.px, s, shade)
      dw = Math.ceil(walls.w / s)
      dhigh = Math.ceil(walls.h / s)
    } else if (st.view === 'iso') {
      // The diamond is wider than the flat map: the finest sampling at which it fits the pane
      // whole and inside the drawing budget.
      const iso = projectIso(compose(st, p), W, H)
      let found: { s: number; look: Look; dw: number; dh: number; zoom: number } | null = null
      for (const sv of [p.s, 2 * p.s, 4 * p.s, 8 * p.s]) {
        const w = Math.ceil(iso.w / sv), h = Math.ceil(iso.h / sv), fz = fit({ w, h, zoom: 0 }, cols, props.rows, boxes), lk = pictureLook(st, iso.w, iso.px, sv, null)
        found = { s: sv, look: lk, dw: w, dh: h, zoom: fz.half ? 0.5 : fz.z }
        if ((fz.half ? w <= cols : fz.span >= w) && fz.visible >= fz.total && canvas(lk, w, h, fz, 0, null, CANVAS_BUDGET, { boxes }).bands >= fz.total) break
      }
      s = found!.s
      isoZoom = found!.zoom
      look = found!.look
      dw = found!.dw
      dhigh = found!.dh
    } else {
      s = p.s
      look = pictureLook(st, W, compose(st, p), s, shade)
      dw = Math.ceil(W / s)
      dhigh = Math.ceil(H / s)
    }
    zoomAs = view === 'iso' ? isoZoom : p.step < 1 ? 0.5 : p.step
    top = st.top
    left = st.left
  } else {
    const fitted = sheetStep(st, cols, props.rows, boxes)
    s = fitted.s
    W = H = SHEET * T
    const px = sheetPixels(st), w = W
    const sheetShade = (mx: number, my: number) => (Math.floor(mx / T) + Math.floor(my / T)) % 2 === 0
    look = pictureLook(st, w, px, s, st.mode === 'cells' ? sheetShade : null)
    dw = dhigh = Math.ceil(W / s)
    zoomAs = fitted.zoom
    top = st.top
    left = st.left
  }
  const f: Fit = fit({ w: dw, h: dhigh, zoom: zoomAs }, cols, props.rows, boxes)
  top = Math.max(0, Math.min(f.total - f.visible, top))
  const span = f.half ? dw : f.span
  left = Math.max(0, Math.min(dw - span, left))
  // The desktop draws the grid as hairlines over the pixels, the terminal as a tint (pixels.tsx).
  const lined = st.grid && boxes && !f.half, across = span < dw
  const drawn = canvas(look, dw, dhigh, f, top, surface.elements,
    CANVAS_BUDGET - (lined ? GRID_LINE_COST * (span + f.visible + 2) : 0) - (across && boxes ? OVERVIEW_BUDGET : 0),
    { boxes, grid: st.grid && !boxes, left })
  const g: Drawn = { ...f, top, left, across: dw, sideways: boxes, bands: drawn.bands, rows: drawn.bands * f.bandRows, plan: p, dw, dh: dhigh, view: e ? 'flat' : view, s, W, H }
  geometry.set(surface, g)
  const grid = lined ? gridLines(surface.elements, g, span) : []
  // Under the canvas, in rows the pointer can find: the whole of a picture wider than the pane (desktop).
  const ov = across && boxes ? overview(look, dw, dhigh, cols, left, span, surface.elements) : null
  if (ov) overviewAt.set(surface, { top: g.rows + 1, height: ov.height, pw: ov.pw, step: ov.step })
  else overviewAt.delete(surface)
  const overviewBox = ov && <Box key="overview" flexDirection="column" marginTop={1} height={ov.height} overflow="hidden">{ov.rows}</Box>
  const scrolls = g.bands < g.total
  const hex = st.color >= 0 ? st.palette[st.color] : null
  const extra = EXTRA.filter((c) => !st.palette.includes(c))
  // Each chip sits beside its Button, not in it: the desktop draws a Button's Text children in its own colour.
  const swatches = (
    <Box key="palette" flexWrap="wrap" marginTop={1}>
      {st.palette.slice(0, PALETTE_SHOWN).map((c, i) => (
        <Box key={`swatch-${i}`} marginRight={1}>
          <Text color={c}>██</Text>
          <Button key={`c${i}`} plain label={i === st!.color && !(e && e.tool === 'eraser') ? `[${i + 1}]` : `${i + 1}`} onPress={set((x) => addColor(x, x.palette[i]!))} />
        </Box>
      ))}
      {st.palette.length > PALETTE_SHOWN && <Text dimColor>{` +${st.palette.length - PALETTE_SHOWN} more (Pick takes any)`}</Text>}
    </Box>
  )
  const colours = (
    <Box key="colours" flexDirection="column">
      {extra.length > 0 && (
        <Box key="extra" flexWrap="wrap">
          <Text dimColor>add </Text>
          {extra.map((c) => (
            <Box key={`extra-${c.slice(1)}`} marginRight={1}>
              <Text color={c}>██</Text>
              <Button key={`x${c.slice(1)}`} plain label="+" onPress={set((x) => addColor(x, c))} />
            </Box>
          ))}
        </Box>
      )}
      <Box key="hexrow">
        <Input key="hex" label="Colour " placeholder="#rrggbb" submitLabel="add" onSubmit={(value) => {
          const x = surface.state
          if (!x) return
          const v = value.trim().toLowerCase().replace(/^([0-9a-f]{6})$/, '#$1')
          surface.setState(/^#[0-9a-f]{6}$/.test(v) ? addColor(x, v) : { ...x, note: `"${value.trim()}" isn't a colour like #a1b2c3.` })
        }} />
      </Box>
    </Box>
  )
  // The toolbar's shared groups: history, then view (zoom, grid, scrolling).
  const history = (
    <Box key="history" columnGap="xs">
      <Button key="undo" label="Undo" onPress={set((x) => restore(x, 'undo'))} />
      <Button key="redo" label="Redo" onPress={set((x) => restore(x, 'redo'))} />
    </Box>
  )
  const viewGroup = (
    <Box key="display" columnGap="xs">
      <Button key="zoom-out" label="-" onPress={() => zoom(surface, -1)} />
      <Button key="zoom-in" label="+" onPress={() => zoom(surface, 1)} />
      <Button key="grid" label="Grid" variant={st.grid ? 'primary' : 'secondary'} onPress={set((x) => ({ ...x, grid: !x.grid }))} />
      {scrolls && <Button key="up" label="▲" onPress={() => scroll(surface, -Math.max(1, g.bands - 1))} />}
      {scrolls && <Button key="down" label="▼" onPress={() => scroll(surface, Math.max(1, g.bands - 1))} />}
      {across && <Button key="left" label="◀" onPress={() => scrollX(surface, -Math.max(1, Math.floor(span / 2)))} />}
      {across && <Button key="right" label="▶" onPress={() => scrollX(surface, Math.max(1, Math.floor(span / 2)))} />}
    </Box>
  )
  const keysButton = <Button key="help" label="Keys" variant={st.help ? 'primary' : 'secondary'} onPress={set((x) => ({ ...x, help: !x.help }))} />
  const keys = st.help && <Box key="keys" flexDirection="column">{SHORTCUTS.map((l, i) => <Text key={`keys-${i}`} dimColor wrap="wrap">{l}</Text>)}</Box>
  const shown = rowsShown(g, dhigh) + (across ? ` · columns ${left + 1}-${left + span} of ${dw} (${ov ? 'click the overview, ' : ''}Shift+Left/Right)` : '')

  if (e) {
    const corners = cornersOf(e.mask)
    const title = e.base ? 'Base texture: Done derives every edge tile from it again; tiles drawn by hand stay'
      : st.kind === 'wang' ? `Tile ${e.mask}: drawn where ${corners.length ? corners.join('+') : 'no corner'} ${corners.length === 1 ? 'is' : 'are'} painted`
      : `Tile ${e.mask} (row ${Math.floor(e.mask / SHEET) + 1}, column ${(e.mask % SHEET) + 1})`
    const label = (TOOLS.find(([k]) => k === e.tool) || [e.tool, e.tool])[1]
    return (
      <Box flexDirection="column">
        <Box key="canvas" flexDirection="column">{drawn.rows}{grid}</Box>
        {overviewBox}
        {swatches}
        {/* The tools; then what the chosen one does. */}
        <Box key="tools" flexWrap="wrap" columnGap={2} marginTop={1}>
          <Box key="tools-0" flexWrap="wrap" columnGap="xs">
            {TOOLS.map(([t, name]) => (
              <Button key={`t-${t}`} label={name} variant={e.tool === t ? 'primary' : 'secondary'} onPress={set((x) => (x.edit ? { ...x, edit: { ...x.edit, tool: t }, note: '' } : x))} />
            ))}
          </Box>
        </Box>
        <Text key="tool-help" dimColor wrap="wrap">{`${label} (${TOOL_KEY[e.tool]}): ${TOOL_HELP[e.tool]}`}</Text>
        {/* History, view, the tile's own changes and the way out. */}
        <Box key="main" flexWrap="wrap" columnGap={2} marginTop={1}>
          {history}
          {viewGroup}
          <Box key="tile" columnGap="xs">
            {e.base && (
              <Button key="offset" label="Offset ½" variant={e.offset ? 'primary' : 'secondary'} onPress={set((x) => (x.edit ? editArt(x, shifted(x.edit.art, x.T, !x.edit.offset), !x.edit.offset) : x))} />
            )}
            {st.prev[e.mask] && <Button key="previous" label="Previous version" onPress={set((x) => (x.edit && x.prev[x.edit.mask] ? editArt(x, x.prev[x.edit.mask]!.slice(), false) : x))} />}
            <Button key="studio" label="Open in pixel editor" onPress={() => toStudio(surface)} />
          </Box>
          <Box key="out" columnGap="xs">
            {keysButton}
            <Button key="done" label="Done" variant="primary" onPress={set(done)} />
            <Button key="cancel" label="Cancel" onPress={set((x) => ({ ...x, edit: null, drag: null, note: '' }))} />
          </Box>
        </Box>
        {keys}
        {colours}
        <Text key="status" dimColor wrap="truncate-end">
          {st.note || `${title} · ${e.tool}${e.tool === 'eraser' ? '' : hex ? ` ${hex}` : ' (no colour)'}${e.offset ? ' · offset ½ (seams in the middle)' : ''}` +
            `${shown} · Enter is Done`}
        </Text>
      </Box>
    )
  }

  const painting = st.mode === 'cells' || st.view !== 'flat'
  const modeHelp = st.kind === 'platformer'
    ? st.mode === 'cells' ? 'Pick tiles (M): click a tile to edit it' : 'Edit pixels (P): draw on the sheet; right-click picks a colour'
    : painting ? `Paint map (M)${st.view === 'flat' ? '' : `, previewed as ${VIEW_LABEL[st.view]}`}: click or drag cells to paint them, right-click clears them`
    : 'Edit pixels (P): a stroke lands in the tile under it, and every repeat follows; right-click picks a colour'
  const status = st.kind === 'platformer'
    ? `${st.mode === 'cells' ? 'pick tiles' : `edit pixels${hex ? ` ${hex}` : ''}`} · 49 tiles of ${T}px${s > 1 ? ` at 1/${s} size` : ''}${shown}`
    : `${painting ? `paint map${st.view === 'flat' ? '' : ` (${VIEW_LABEL[st.view]})`}` : `edit pixels${hex ? ` ${hex}` : ''}`}` +
      ` · ${T}px tiles · ${p!.mw}x${p!.mh} cells${p!.s > 1 ? ` at 1/${p!.s} size` : ''}${shown}`
  return (
    <Box flexDirection="column">
      <Box key="canvas" flexDirection="column">{drawn.rows}{grid}</Box>
      {overviewBox}
      {swatches}
      {/* The map's modes and its own changes; then what the mode does. */}
      <Box key="modes" flexWrap="wrap" columnGap={2} marginTop={1}>
        <Box key="modes-0" columnGap="xs">
          <Button key="m-cells" label={st.kind === 'wang' ? 'Paint map' : 'Pick tiles'} variant={st.mode === 'cells' ? 'primary' : 'secondary'} onPress={set((x) => setMode(x, 'cells'))} />
          {(st.kind === 'platformer' || st.view === 'flat') && (
            <Button key="m-pixels" label="Edit pixels" variant={st.mode === 'pixels' ? 'primary' : 'secondary'} onPress={set((x) => setMode(x, 'pixels'))} />
          )}
        </Box>
        {st.kind === 'wang' && (
          <Box key="modes-1" columnGap="xs">
            <Button key="view" label={`View: ${VIEW_LABEL[st.view]}`} onPress={set((x) => {
              const v = VIEWS[(VIEWS.indexOf(x.view) + 1) % VIEWS.length]!
              return { ...x, view: v, mode: v === 'flat' ? x.mode : 'cells', drag: null, top: 0, left: 0, note: v === 'flat' ? '' : `Previewed as ${VIEW_LABEL[v]}: paint cells to see it.` }
            })} />
            <Button key="clear" label="Clear map" onPress={set((x) => ({ ...x, cells: [], note: 'Map cleared; the tiles are untouched.' }))} />
          </Box>
        )}
      </Box>
      <Text key="mode-help" dimColor wrap="wrap">{modeHelp}</Text>
      {/* History, view and the way out. */}
      <Box key="main" flexWrap="wrap" columnGap={2} marginTop={1}>
        {history}
        {viewGroup}
        <Box key="out" columnGap="xs">
          {keysButton}
          <Button key="save" label="Save to prompt" variant="primary" onPress={() => save(surface)} />
        </Box>
      </Box>
      {keys}
      {st.kind === 'wang' && (
        <Box key="tiles" flexWrap="wrap" columnGap={1} marginTop={1}>
          <Text key="tiles-label" dimColor>Edit a tile:</Text>
          {/* The glyph (the tile's corners, in its main colour) beside its Button, as the swatches are. */}
          {st.tiles.map((t, m) => (
            <Box key={`tile-chip-${m}`}>
              <Text color={dominant(t, st!.palette)} dimColor={m === 0 || undefined}>{m === 0 ? '·' : QUADS[m]}</Text>
              <Button key={`tile-${m}`} plain label={`${m}`} onPress={set((x) => openTile(x, m))} />
            </Box>
          ))}
          <Button key="base" label="Base texture" onPress={set((x) => openTile(x, BASE, true))} />
        </Box>
      )}
      {colours}
      <Text key="status" dimColor wrap="truncate-end">{st.note || status}</Text>
    </Box>
  )
}

export default Tiles
