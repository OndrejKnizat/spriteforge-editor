// Drawing pixels with text, shared by the editor panes' Client modules.
//
// Two ways to draw a pixel: "block" (2z columns x z rows of full blocks per pixel, z = 1..4) and
// "half" (one column, half a row: an upper-half block whose foreground is the top pixel and whose
// background is the bottom one), used when the picture is too big for blocks. In half mode the
// pointer's sub-cell position (fine.y) says which half was clicked; terminals that report no
// pixel positions get the top half.
//
// A drawing is held to 100,000 serialized characters, and a detailed picture is one colour run
// per few pixels, so `canvas` draws the rows ("bands") that fit both the pane and a size budget,
// from `top`, and the pane scrolls when that is not all of them.
import type { ClientPointerEvent, ClientSurface } from 'claude-code'
import { hexHsv, hsvHex, lum, mixHex } from './tools'

// A band is one pixel row (block mode, z cell rows tall) or two (half mode, one cell row). `cw`: the
// columns a pixel takes across (2z unless square). `span`: the pixel columns that fit across; a
// picture wider than that is drawn from column `left`.
export type Fit = { half: boolean; z: number; bandRows: number; total: number; visible: number; span: number; cw?: number }
export type Geo = Fit & { top: number; bands: number; rows: number; left?: number; across?: number; sideways?: boolean }
export type Put = (x: number, y: number) => void
// How a pixel is drawn: empty, its colour, a faint ghost (onion skin, a see-through layer), on a
// selection's edge (over a colour, or over nothing), a faint shade (an empty map cell), a
// selection's corner handle or its rotation pivot; and the colour.
export type Look = (x: number, y: number) => [number, string | undefined]
export const EMPTY = 0, SOLID = 1, GHOST = 2, EDGE = 3, EDGE_EMPTY = 4, SHADE = 5, HANDLE = 6, PIVOT = 7
const GLYPH = ['·', '█', '▒', '▓', '░', '█', '▚', '◆']
// What an empty pixel shows in block mode: a dot, a checkerboard, nothing, or spriteforge.tech's sprite
// plate.
export const BACKDROPS = ['dots', 'checker', 'blank', 'plate'] as const
// spriteforge.tech's tokens (landing.html :root): the plate sprites sit on and its line (--sf-stage,
// --sf-stage-line), the chip surface (--sf-line2), the CTA base (--sf-cta-base) and the gold wordmark.
export const PLATE = '#34312b', PLATE_LINE = '#57524a', GOLD = '#f2cd6b', SITE = 'https://www.spriteforge.tech'
const dimmed = (k: number) => k === GHOST || k === SHADE

// How `canvas` draws. `boxes` (the desktop) paints block-mode pixels as Box backgrounds: its text
// leaves a gap under every row of blocks and draws the shade glyphs wider than a block, so there each
// kind of pixel is a colour instead. `grid` (the terminal's grid) tints every other pixel and shows
// empty ones as a checker: a cell is the thinnest line text can draw.
export type Draw = { backdrop?: number; boxes?: boolean; grid?: boolean; left?: number }
const CHECK = '#80808040', LINE = `${PLATE_LINE}cc`
const isHex = (c: string) => /^#[0-9a-f]{6}$/i.test(c)
const faint = (c: string, alpha: string) => (isHex(c) ? c + alpha : c)
const contrast = (c: string, t: number) => (isHex(c) ? mixHex(c, lum(c) > 0.5 ? '#000000' : '#ffffff', t) : c)
const fill = (k: number, c: string) =>
  k === GHOST || k === SHADE ? faint(c, '80')
  : k === EDGE ? contrast(c, 0.45)
  : k === EDGE_EMPTY ? faint(c, '99')
  : k === HANDLE ? (isHex(c) && lum(c) > 0.5 ? '#000000' : '#ffffff')
  : c

// Frames travel as strings of w*h cells: "." is transparent, any other character the palette
// index String.fromCharCode(0x100 + index).
export const decodeFrame = (s: string, n: number): number[] => {
  const out = new Array<number>(n)
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i)
    out[i] = Number.isNaN(c) || c === 46 ? -1 : c - 0x100
  }
  return out
}
export const encodeFrame = (d: number[]): string => d.map((v) => (v < 0 ? '.' : String.fromCharCode(0x100 + v))).join('')

// A desktop cell's width over its height (11.75 x 28.4 px), so two columns a row draw a pixel a fifth
// taller than wide. Square, a pixel is z rows tall and as many columns across as that is wide, a
// fraction of a cell more than 2z: Box widths take fractions, and at least two cells a pixel keeps
// every one in the pointer's reach.
export const CELL_ASPECT = 0.414
const r3 = (v: number) => Math.round(v * 1000) / 1000
export const cellWidth = (z: number, square: boolean) => (square ? r3(z / CELL_ASPECT) : 2 * z)

// `sideways` (the desktop): never half blocks, whose lower pixel only a terminal reporting positions
// inside a cell can reach; a picture too wide for the pane keeps full-size pixels and scrolls across.
export function fit(st: { w: number; h: number; zoom: number }, cols: number, rows: number, sideways = false, square = false): Fit {
  const room = Math.max(4, rows)
  const half = (): Fit => ({ half: true, z: 1, bandRows: 1, total: Math.ceil(st.h / 2), visible: Math.min(Math.ceil(st.h / 2), room), span: st.w, cw: 1 })
  const block = (z: number): Fit => {
    const cw = cellWidth(z, square)
    return {
      half: false, z, bandRows: z, total: st.h, visible: Math.max(1, Math.min(st.h, Math.floor(room / z))),
      span: Math.max(1, Math.min(st.w, Math.floor((cols || cw * st.w) / cw))), cw,
    }
  }
  if (st.zoom === 0.5) return sideways ? block(1) : half()
  if (st.zoom >= 1) return block(st.zoom)
  for (let z = 4; z >= 1; z--) if (cellWidth(z, square) * st.w <= cols && st.h * z <= room) return block(z)
  return cellWidth(1, square) * st.w <= cols || sideways ? block(1) : half()
}

export function pixelAt(ev: ClientPointerEvent, g: Geo, st: { w: number; h: number }, clamp: boolean): [number, number] | null {
  const fx = ev.fine ? ev.fine.x : ev.x, fy = ev.fine ? ev.fine.y : ev.y
  let band = Math.floor(fy / g.bandRows)
  if (clamp) band = Math.max(0, Math.min(g.bands - 1, band))
  else if (band < 0 || band >= g.bands) return null
  let x: number, y: number
  if (g.half) {
    x = Math.floor(fx)
    y = (g.top + band) * 2 + (ev.fine && fy - Math.floor(fy) >= 0.5 ? 1 : 0)
  } else {
    x = Math.floor((ev.fine ? fx : fx + 0.5) / (g.cw || 2 * g.z)) + (g.left || 0)
    y = g.top + band
  }
  if (clamp) return [Math.max(0, Math.min(st.w - 1, x)), Math.max(0, Math.min(st.h - 1, y))]
  return x >= 0 && y >= 0 && x < st.w && y < st.h ? [x, y] : null
}

// The zoom steps of the - and + buttons, from the drawing now on screen (no half blocks sideways).
export function zoomStep(g: Fit, dir: number, sideways = false): number {
  const steps = sideways ? [1, 2, 3, 4] : [0.5, 1, 2, 3, 4]
  return steps[Math.max(0, Math.min(steps.length - 1, steps.indexOf(g.half ? 0.5 : g.z) + dir))]!
}

export function line(x0: number, y0: number, x1: number, y1: number, put: Put) {
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1
  let err = dx + dy
  for (;;) {
    put(x0, y0)
    if (x0 === x1 && y0 === y1) return
    const e2 = 2 * err
    if (e2 >= dy) { err += dy; x0 += sx }
    if (e2 <= dx) { err += dx; y0 += sy }
  }
}

export function flood(d: number[], w: number, h: number, start: number, v: number) {
  const from = d[start]!
  if (from === v) return
  const stack = [start]
  while (stack.length) {
    const i = stack.pop()!
    if (d[i] !== from) continue
    d[i] = v
    const px = i % w, py = (i - px) / w
    if (px > 0) stack.push(i - 1)
    if (px < w - 1) stack.push(i + 1)
    if (py > 0) stack.push(i - w)
    if (py < h - 1) stack.push(i + w)
  }
}

// Draws a width x height picture's bands from `top` until the pane's rows or `budget` serialized
// characters run out; returns them and how many. Without `els` it only counts what would fit.
export function canvas(base: Look, width: number, height: number, f: Fit, top: number, els: ClientSurface['elements'] | null, budget: number, o: Draw = {}) {
  const Box = els?.Box!, Text = els?.Text!
  const backdrop = o.grid ? 1 : o.backdrop ?? 0, from = f.half ? 0 : Math.max(0, Math.min(width - 1, o.left ?? 0))
  const cw = f.cw || 2 * f.z, at = (i: number) => r3(cw * (i - from)) // where pixel i starts, in columns
  const look: Look = o.grid
    ? (x, y) => { const [k, c] = base(x, y); return k === SOLID && c && (x + y) % 2 ? [k, contrast(c, 0.12)] : [k, c] }
    : base
  const rows = []
  let size = 0, bands = 0
  for (let b = top; b < f.total && bands < f.visible; b++) {
    const runs = []
    let cost = 40
    if (!f.half) {
      const y = b, z = f.z, mono = z > 1 || undefined, end = Math.min(width, from + f.span)
      let x = from
      while (x < end) {
        const [k, c] = look(x, y)
        let n = 1
        for (; x + n < end; n++) {
          const [k2, c2] = look(x + n, y)
          if (k2 !== k || c2 !== c) break
        }
        const cols = 2 * z * n
        // z cell rows per pixel: one multi-line run, so zooming in costs no extra elements.
        const empty = () => {
          if (backdrop >= 2) return new Array(z).fill(' '.repeat(cols)).join('\n')
          if (backdrop === 1) {
            const line = Array.from({ length: n }, (_, i) => ((x + i + y) % 2 ? ' ' : '░').repeat(2 * z)).join('')
            return new Array(z).fill(line).join('\n')
          }
          return [('·' + ' '.repeat(2 * z - 1)).repeat(n)].concat(new Array(z - 1).fill(' '.repeat(cols))).join('\n')
        }
        if (o.boxes) {
          const box = (w: number, bg?: string, dots?: string) => {
            if (els) runs.push(dots
              ? <Box width={w} height={z} overflow="hidden"><Text dimColor>{dots}</Text></Box>
              : <Box width={w} height={z} backgroundColor={bg} />)
            cost += 75 + (dots ? 60 + dots.length : 0)
          }
          const across = r3(at(x + n) - at(x))
          if (k !== EMPTY) box(across, fill(k, c!))
          else if (backdrop === 0) box(across, undefined, empty())
          else if (backdrop >= 2) box(across, backdrop === 3 ? PLATE : undefined)
          else for (let i = 0; i < n; i++) box(r3(at(x + i + 1) - at(x + i)), (x + i + y) % 2 ? undefined : CHECK)
          x += n
          continue
        }
        const glyph = k === HANDLE || k === PIVOT ? GLYPH[k]! + '█'.repeat(2 * z - 1) : null
        const text = k === EMPTY ? empty()
          : glyph ? new Array(z).fill(glyph.repeat(n)).join('\n')
          : new Array(z).fill(GLYPH[k]!.repeat(cols)).join('\n')
        if (els) runs.push(k === EMPTY
          ? backdrop === 3 ? <Text backgroundColor={PLATE} mono={mono}>{text}</Text> : <Text dimColor mono={mono}>{text}</Text>
          : <Text color={c} dimColor={dimmed(k) || undefined} mono={mono}>{text}</Text>)
        cost += 58 + text.length + (dimmed(k) ? 16 : 0)
        x += n
      }
      if (bands > 0 && size + cost > budget) break
      if (els) rows.push(o.boxes
        ? <Box key={`r${y}`} flexDirection="row" height={z} flexShrink={0}>{runs}</Box>
        : z > 1
          ? <Box key={`r${y}`} flexDirection="row">{runs}</Box>
          : <Text key={`r${y}`} mono wrap="truncate-end">{runs}</Text>)
    } else {
      const y = b * 2
      const half = (x: number, yy: number): { c: string; dim: boolean } | null => {
        if (yy >= height) return null
        const [k, c] = look(x, yy)
        return k === EMPTY ? null : { c: c!, dim: dimmed(k) }
      }
      const cellAt = (x: number) => {
        let t = half(x, y), u = half(x, y + 1)
        // Dimming takes the whole cell, so a ghost gives way to a real pixel beside it.
        if (t && u && t.dim !== u.dim) {
          if (t.dim) t = null
          else u = null
        }
        const dim = !!(t ? t.dim : u && u.dim)
        if (!t && !u) return { ch: ' ', fg: undefined, bg: undefined, dim }
        if (!t) return { ch: '▄', fg: u!.c, bg: undefined, dim }
        if (!u || u.c === t.c) return { ch: u ? '█' : '▀', fg: t.c, bg: undefined, dim }
        return { ch: '▀', fg: t.c, bg: u.c, dim }
      }
      let x = 0
      while (x < width) {
        const c = cellAt(x)
        let n = 1
        for (; x + n < width; n++) {
          const o = cellAt(x + n)
          if (o.ch !== c.ch || o.fg !== c.fg || o.bg !== c.bg || o.dim !== c.dim) break
        }
        if (els) runs.push(<Text color={c.fg} backgroundColor={c.bg} dimColor={c.dim || undefined}>{c.ch.repeat(n)}</Text>)
        cost += 58 + n + (c.bg ? 28 : 0) + (c.dim ? 16 : 0)
        x += n
      }
      if (bands > 0 && size + cost > budget) break
      if (els) rows.push(<Text key={`h${b}`} mono wrap="truncate-end">{runs}</Text>)
    }
    size += cost
    bands++
  }
  return { rows, bands }
}

// The desktop's overview of a picture wider than the pane, drawn under the canvas: all of it at a
// fraction of a cell a pixel, the columns out of view faint. The pointer gives whole cells, which can't
// reach pixels that small, so a click there only moves the view. A detailed picture is sampled every
// `step` pixels to keep it small.
const VIEW = '#ffffff14'
export const OVERVIEW_BUDGET = 12_000
export type Overview = { rows: unknown[]; pw: number; step: number; height: number }
export function overview(look: Look, width: number, height: number, cols: number, from: number, span: number, els: ClientSurface['elements']): Overview {
  const Box = els.Box
  for (let step = 1; ; step++) {
    const sw = Math.ceil(width / step), sh = Math.ceil(height / step)
    const pw = r3(Math.min(1, (cols - 1) / sw)), ph = r3(pw * CELL_ASPECT)
    const bg = (sx: number, sy: number) => {
      const X = sx * step, [k, c] = look(X, sy * step), shown = X >= from && X < from + span
      if (k === EMPTY) return shown ? VIEW : undefined
      const fc = fill(k, c!)
      return shown ? fc : faint(fc, '59')
    }
    const rows = []
    let cost = 0
    for (let sy = 0; sy < sh; sy++) {
      const runs = []
      for (let sx = 0; sx < sw;) {
        const b = bg(sx, sy)
        let n = 1
        while (sx + n < sw && bg(sx + n, sy) === b) n++
        runs.push(<Box width={r3(pw * n)} height={ph} backgroundColor={b} />)
        cost += 75
        sx += n
      }
      rows.push(<Box key={`o${sy}`} flexDirection="row" height={ph}>{runs}</Box>)
      cost += 50
    }
    if (cost <= OVERVIEW_BUDGET || step >= 16) return { rows, pw, step, height: Math.ceil(sh * ph) }
  }
}

// The panes' Button. The desktop draws one as bare text and nothing reacts to hover inside a pane
// there, so each Button that isn't `plain` sits on a filled chip in the site's colours, gold while it
// is on; the terminal draws its own `[ label ]`.
const CHIP = '#3f3b33', CHIP_ON = '#8a6a3e'
export function chips(els: ClientSurface['elements'], boxes: boolean): ClientSurface['elements']['Button'] {
  const Plain = els.Button, Box = els.Box
  if (!boxes) return Plain
  return (p) => (p.plain ? Plain(p) : <Box paddingX="xs" backgroundColor={p.variant === 'primary' ? CHIP_ON : CHIP}>{Plain(p)}</Box>)
}

// The desktop's grid: hairlines laid over a block-mode canvas drawn from the region's top-left.
// Absolute Boxes take no room and leave the pointer to the canvas (gaps or borders between pixels
// would move them off the cells the pointer reports); the desktop places them from the region's
// corner. A fraction of a cell is the hairline: percentages there are of the whole region, in
// whole numbers only.
export const GRID_LINE_COST = 125
export function gridLines(els: ClientSurface['elements'], g: Geo, width: number) {
  const Box = els.Box, cw = g.cw || 2 * g.z, at = (i: number) => r3(cw * i)
  if (g.half) return []
  // An absolute Box's `left` takes whole cells only, so the upright lines are one row of line and
  // spacer Boxes from the corner, whose widths may be fractions.
  const upright = []
  for (let i = 0; i <= width; i++) {
    upright.push(<Box width={0.12} height={g.rows} backgroundColor={LINE} />)
    if (i < width) upright.push(<Box width={r3(at(i + 1) - at(i) - 0.12)} height={g.rows} />)
  }
  const lines = [<Box key="gv" position="absolute" left={0} top={0} flexDirection="row" height={g.rows}>{upright}</Box>]
  for (let j = 0; j <= g.bands; j++) lines.push(<Box key={`gh${j}`} position="absolute" left={0} top={j * g.z} width={at(width)} height={0.05} backgroundColor={LINE} />)
  return lines
}

// The rows a scrolled drawing shows, for the status line.
export function rowsShown(g: Geo, height: number): string {
  return g.bands < g.total ? ` · rows ${g.half ? g.top * 2 + 1 : g.top + 1}-${Math.min(height, g.half ? (g.top + g.bands) * 2 : g.top + g.bands)} (Up/Down)` : ''
}

// ── the palette ──
// One chip per colour, in rows of a fixed width so the pane knows where each chip is and a press
// anywhere on it picks that colour (the colour is drawn, so the pane maps the pointer; the number
// beside it is also a Button, for the keyboard and the tests). A chip: 2 columns of colour, 4 of
// number (on the site's chip colour, gold while it is the colour in use), then a 1-column gap.
export const SWATCH_W = 7
export const swatchesPerRow = (cols: number) => Math.max(1, Math.floor((cols + 1) / SWATCH_W))
export type Swatch = { hex: string; label: string; lit: boolean; onPress: () => void }
export function swatchRows(els: ClientSurface['elements'], boxes: boolean, chips: Swatch[], cols: number) {
  const { Box, Text, Button } = els, per = swatchesPerRow(cols)
  const chip = (c: Swatch, i: number) => boxes
    ? (
      <Box key={`swatch-${i}`} flexDirection="row" width={SWATCH_W} height={1} flexShrink={0}>
        <Box width={2} height={1} backgroundColor={c.hex} />
        <Box width={4} height={1} backgroundColor={c.lit ? CHIP_ON : CHIP} justifyContent="center">
          <Button key={`c${i}`} plain label={c.label} onPress={c.onPress} />
        </Box>
      </Box>
    )
    : (
      <Box key={`swatch-${i}`} flexDirection="row" width={SWATCH_W} flexShrink={0}>
        <Text color={c.hex}>██</Text>
        <Button key={`c${i}`} plain label={c.label} onPress={c.onPress} />
      </Box>
    )
  return Array.from({ length: Math.ceil(chips.length / per) }, (_, r) => (
    <Box key={`pal${r}`} flexDirection="row" height={1} flexShrink={0}>{chips.slice(r * per, r * per + per).map((c, k) => chip(c, r * per + k))}</Box>
  ))
}
// The chip under a press on the palette's rows (drawn from row `top`), or -1.
export function swatchAt(ev: ClientPointerEvent, top: number, count: number, cols: number): number {
  const per = swatchesPerRow(cols), col = Math.floor(ev.x / SWATCH_W)
  if (ev.y < top || col >= per) return -1
  const i = (ev.y - top) * per + col
  return i < count ? i : -1
}

// ── the colour picker ──
// As in SpriteForge's Edit studio: a saturation (across) by value (down) square in the colour's hue,
// then a hue strip, one cell per step, so the pointer can find each step on either surface.
export const PICK_W = 40, PICK_H = 9
export type Hsv = [number, number, number]
// The picker's hue, saturation and value for colour `cur`, keeping the last hue while `cur` is a grey.
export function pickFor(cur: string | null, pick: Hsv): Hsv {
  const [h] = pick
  if (!cur || hsvHex(pick[0], pick[1], pick[2]) === cur) return pick
  const c = hexHsv(cur)
  return [c.s > 0 ? c.h : h, c.s, c.v]
}
// A press at step x of the square's row y, or of the hue strip.
export function pickStep(hsv: Hsv, x: number, y: number | 'hue'): Hsv {
  let [h, s, v] = hsv
  const cx = Math.max(0, Math.min(PICK_W - 1, x))
  if (y === 'hue') h = (cx / PICK_W) * 360
  else { s = cx / (PICK_W - 1); v = 1 - Math.max(0, Math.min(PICK_H - 1, y)) / (PICK_H - 1) }
  return [h, s, v]
}
// The picker's cells, the square row by row and then the hue strip; a ring marks the colour now set,
// dark on a light cell and light on a dark one, as the studio's does.
export function pickerRows(els: ClientSurface['elements'], boxes: boolean, hsv: Hsv) {
  const { Box, Text } = els
  const [hue, s, v] = hsv
  const mx = Math.round(s * (PICK_W - 1)), my = Math.round((1 - v) * (PICK_H - 1)), hx = Math.floor((hue / 360) * PICK_W) % PICK_W
  const cell = (x: number, y: number): [string, boolean, string] => y === PICK_H
    ? [hsvHex((x / PICK_W) * 360, 1, 1), x === hx, '#ffffff']
    : [hsvHex(hue, x / (PICK_W - 1), 1 - y / (PICK_H - 1)), x === mx && y === my, 1 - y / (PICK_H - 1) > 0.6 ? '#000000' : '#ffffff']
  return Array.from({ length: PICK_H + 1 }, (_, y) => {
    const cells = Array.from({ length: PICK_W }, (_, x) => {
      const [c, mark, ring] = cell(x, y)
      if (boxes) return <Box width={1} height={1} backgroundColor={c}>{mark ? <Text color={ring}>◆</Text> : null}</Box>
      return mark ? <Text color={ring} backgroundColor={c}>◆</Text> : <Text color={c}>█</Text>
    })
    return boxes
      ? <Box key={`p${y}`} flexDirection="row" height={1} flexShrink={0}>{cells}</Box>
      : <Text key={`p${y}`} mono wrap="truncate-end">{cells}</Text>
  })
}
// Where a press lands on the picker drawn from row `top`: the square's row, or the strip; null off it.
export function pickerHit(ev: ClientPointerEvent, top: number): { x: number; on: 'sv' | 'hue'; y: number | 'hue' } | null {
  const x = Math.floor(ev.fine ? ev.fine.x : ev.x)
  if (ev.y < top || ev.y > top + PICK_H || x < 0 || x >= PICK_W) return null
  return ev.y === top + PICK_H ? { x, on: 'hue', y: 'hue' } : { x, on: 'sv', y: ev.y - top }
}

// The colour in use, larger than a chip, beside the tools: a block of it and its hex ("none" for
// the eraser or no colour).
export function colourNow(els: ClientSurface['elements'], boxes: boolean, hex: string | null, key = 'now') {
  const { Box, Text } = els
  return (
    <Box key={key} flexDirection="row" columnGap={1}>
      {boxes
        ? <Box width={4} height={1} backgroundColor={hex || CHIP} />
        : hex ? <Text color={hex}>████</Text> : <Text dimColor>····</Text>}
      <Text dimColor={!hex}>{hex || 'none'}</Text>
    </Box>
  )
}
