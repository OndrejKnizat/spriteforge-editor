// The spriteforge-editor plugin's mod: SpriteForge's pixel editor and tile editor, as panes inside
// a Claude Code conversation (the plugin's connector, .mcp.json, serves the same editors as cards in
// Claude's chat apps).
//
// /spriteforge-draw [file.png | WxH], or Claude's open_pixel_editor tool, puts a sprite in the
// editor pane; its region (editor.tsx) draws it and takes the mouse and keys; "Send to Claude"
// posts the pixels back here and they land in the prompt box as a GRID + PALETTE block the
// person sends to Claude. /spriteforge-tiles and open_tile_editor do the same for a 16-tile Wang
// terrain set in the tile editor pane (tiles.tsx, wang.ts). Nothing leaves the machine: PNGs are
// decoded here (png.ts).
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { DrawDoc, TileDoc } from '../types'
import { ase, asciiArt, base64, gif, png } from './encode'
import { GOLD, SITE } from './pixels'
import { spriteFromPng } from './png'
import { BASE, GRASS, TILES, deriveTiles, grassBase } from './wang'

const PANE = 'spriteforge-draw'
const TOOL = 'open_pixel_editor'
const MAX_SIDE = 64
const MAX_FRAMES = 16
const MAX_COLORS = 256
// Where a sprite too big for the pane can go instead (edit links take up to 128x128).
const BIGGER = "SpriteForge's browser editor on spriteforge.tech takes up to 128x128: ask Claude for an edit link (/spriteforge-editor:edit)."
// The pane's rows under the canvas: its head, and the editor's palette, tools, options, tabs and status.
const CONTROL_ROWS = 16
const TILES_PANE = 'spriteforge-tiles'
const TILES_TOOL = 'open_tile_editor'
const TILES_CONTROL_ROWS = 11
const MIN_TILE = 4
const MAX_TILE = 64
const SYMBOLS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const PICO8 = ['#000000', '#1d2b53', '#7e2553', '#008751', '#ab5236', '#5f574f', '#c2c3c7', '#fff1e8',
  '#ff004d', '#ffa300', '#ffec27', '#00e436', '#29adff', '#83769c', '#ff77a8', '#ffccaa']

const doc = atom({ plugin: 'spriteforge-editor', key: 'doc' } as const, null)
const tileset = atom({ plugin: 'spriteforge-editor', key: 'tiles' } as const, null)
// What the last export did, for the pixel editor's status line.
const notice = atom({ plugin: 'spriteforge-editor', key: 'notice' } as const, null)
// A tile coming back from the pixel editor ("Back to tiles") to the tile editor.
const tileBack = atom({ plugin: 'spriteforge-editor', key: 'tileBack' } as const, null)
const PLATFORMER = 49
const SHEET = 7

type OpenSpec = {
  path?: string
  width?: number
  height?: number
  palette?: string[]
  grid?: number[][]
  frames?: { grid: number[][] }[]
  name?: string
}

const encodeFrame = (d: number[]): string => d.map((v) => (v < 0 ? '.' : String.fromCharCode(0x100 + v))).join('')
const decodeFrame = (s: string): number[] => Array.from(s, (c) => (c === '.' ? -1 : c.charCodeAt(0) - 0x100))

function base64Bytes(b64: string): Uint8Array {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const s = b64.replace(/[^A-Za-z0-9+/]/g, '')
  const out = new Uint8Array(Math.floor((s.length * 3) / 4))
  let o = 0
  for (let i = 0; i < s.length; i += 4) {
    const n = (A.indexOf(s[i]!) << 18) | (A.indexOf(s[i + 1] ?? 'A') << 12) | (A.indexOf(s[i + 2] ?? 'A') << 6) | A.indexOf(s[i + 3] ?? 'A')
    if (o < out.length) out[o++] = (n >> 16) & 255
    if (o < out.length) out[o++] = (n >> 8) & 255
    if (o < out.length) out[o++] = n & 255
  }
  return out
}

const normHex = (h: unknown): string | null => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(h ?? '').trim())
  return m ? '#' + m[1]!.toLowerCase() : null
}

function checkGrid(g: unknown, colors: number, what: string): number[][] {
  if (!Array.isArray(g) || !g.length || g.length > MAX_SIDE) throw new Error(`${what} must have 1-${MAX_SIDE} rows.`)
  const w = Array.isArray(g[0]) ? g[0].length : 0
  if (w < 1 || w > MAX_SIDE) throw new Error(`${what} rows must have 1-${MAX_SIDE} cells.`)
  return g.map((row, y) => {
    if (!Array.isArray(row) || row.length !== w) throw new Error(`${what} row ${y} must have ${w} cells like the first.`)
    return row.map((v) => {
      if (!Number.isInteger(v) || v < -1 || v >= colors) throw new Error(`${what} cells must be palette indexes 0-${colors - 1}, or -1 for transparent.`)
      return v as number
    })
  })
}

const baseName = (p: string) => (p.split(/[\\/]/).pop() || 'sprite').replace(/\.png$/i, '')

async function buildDoc($: EngineInterface, spec: OpenSpec): Promise<DrawDoc> {
  const prev = await read($, doc)
  const rev = (prev ? prev.rev : 0) + 1
  if (spec.path) {
    const path = String(spec.path)
    let bytes: Uint8Array
    try {
      const r = await $.fs.read(path, { as: 'bytes' })
      bytes = base64Bytes(r.base64)
    } catch (e) {
      throw new Error(`Couldn't read ${path}: ${(e as Error).message}`)
    }
    let s: ReturnType<typeof spriteFromPng>
    try {
      s = spriteFromPng(bytes, MAX_SIDE, MAX_COLORS)
    } catch (e) {
      const m = (e as Error).message
      throw new Error(/^the image is \d+x\d+/.test(m) ? `${m}. ${BIGGER}` : m)
    }
    return { rev, name: spec.name || baseName(path), path, w: s.w, h: s.h, palette: s.palette, frames: [encodeFrame(s.grid)] }
  }
  if (spec.grid || spec.frames) {
    const palette = (spec.palette || []).map((c, i) => {
      const h = normHex(c)
      if (!h) throw new Error(`palette[${i}] isn't a hex colour like "#a1b2c3".`)
      return h
    })
    if (palette.length > MAX_COLORS) throw new Error(`At most ${MAX_COLORS} colours.`)
    const grids = spec.frames && spec.frames.length ? spec.frames.map((f, i) => checkGrid(f && f.grid, palette.length, `frames[${i}].grid`)) : [checkGrid(spec.grid, palette.length, 'grid')]
    if (grids.length > MAX_FRAMES) throw new Error(`At most ${MAX_FRAMES} frames.`)
    const h = grids[0]!.length, w = grids[0]![0]!.length
    if (grids.some((g) => g.length !== h || g[0]!.length !== w)) throw new Error('Every frame must be the same size.')
    return { rev, name: spec.name || 'sprite', path: null, w, h, palette, frames: grids.map((g) => encodeFrame(g.flat())) }
  }
  const w = Math.round(Number(spec.width) || 16), h = Math.round(Number(spec.height) || w)
  if (w < 1 || h < 1 || w > MAX_SIDE || h > MAX_SIDE) throw new Error(`The canvas can be 1-${MAX_SIDE} pixels on each side.${w > MAX_SIDE || h > MAX_SIDE ? ` ${BIGGER}` : ''}`)
  return { rev, name: spec.name || 'sprite', path: null, w, h, palette: PICO8.slice(), frames: [encodeFrame(new Array(w * h).fill(-1))] }
}

async function open($: EngineInterface, spec: OpenSpec) {
  const d = await buildDoc($, spec)
  await update($, doc, () => d)
  const placed = await $.ui.open({ id: PANE, title: `Pixel editor: ${d.name}`, focus: true, rows: Math.min(60, Math.ceil(d.h / (d.w > 40 ? 2 : 1)) + CONTROL_ROWS + 1) })
  if (placed.isPlaced) return { doc: d, isPlaced: true, why: '' }
  const surfaces = await $.session.surfaces().catch(() => [] as readonly string[])
  return { doc: d, isPlaced: false, why: `${placed.reason}; surfaces attached: ${surfaces.length ? surfaces.join(', ') : 'none'}` }
}

// The model's arguments ride beside `tool` and `tool_use_id` on the call, not under a key.
function specFrom(e: Record<string, unknown>): OpenSpec {
  const src = (e.input && typeof e.input === 'object' ? e.input : e) as Record<string, unknown>
  const spec: OpenSpec = {}
  for (const k of ['path', 'width', 'height', 'palette', 'grid', 'frames', 'name'] as const) {
    if (src[k] !== undefined) (spec as Record<string, unknown>)[k] = src[k]
  }
  return spec
}

// Pixels as text for the prompt: letters for up to 62 colours (only those used), "." for
// transparent; frames one GRID each, one PALETTE after. More colours than letters go as JSON.
function gridBlock(w: number, h: number, palette: string[], frames: number[][]): string {
  const used = [...new Set(frames.flat().filter((v) => v >= 0))].sort((a, b) => a - b)
  if (used.length > SYMBOLS.length) {
    const remap = new Map(used.map((v, i) => [v, i]))
    const art = { palette: used.map((v) => palette[v]), frames: frames.map((f) => ({ grid: Array.from({ length: h }, (_, y) => f.slice(y * w, y * w + w).map((v) => (v < 0 ? -1 : remap.get(v)!))) })) }
    return `\n\n\`\`\`json\n${JSON.stringify(art)}\n\`\`\`\n`
  }
  const sym = new Map(used.map((v, i) => [v, SYMBOLS[i]!]))
  const grid = (f: number[]) => Array.from({ length: h }, (_, y) => f.slice(y * w, y * w + w).map((v) => (v < 0 ? '.' : sym.get(v)!)).join('')).join('\n')
  const body = frames.length > 1 ? frames.map((f, i) => `FRAME ${i + 1}\nGRID\n${grid(f)}`).join('\n\n') : `GRID\n${grid(frames[0]!)}`
  const pal = used.map((v) => `${sym.get(v)}=${palette[v]}`).join('\n')
  return `\n\n${body}\n\nPALETTE\n${pal}\n`
}

const colourCount = (frames: number[][]) => {
  const n = new Set(frames.flat().filter((v) => v >= 0)).size
  return `${n} colour${n === 1 ? '' : 's'}`
}

type Timing = { ms?: number[] | null; tags?: { name: string; from: number; to: number }[] }

// How an animation plays: one rate when every frame shares it, else each frame's; and its tags.
function timingText(n: number, t: Timing): string {
  const ms = t.ms && t.ms.length === n ? t.ms : null
  const parts: string[] = []
  if (ms && n > 1) {
    parts.push(ms.every((v) => v === ms[0]) ? `Every frame shows for ${ms[0]} ms.` : `Frame times (ms): ${ms.map((v, i) => `${i + 1}=${v}`).join(', ')}.`)
  }
  if (t.tags && t.tags.length) parts.push(`Tags: ${t.tags.map((g) => `${g.name} = frames ${g.from + 1}-${g.to + 1}`).join('; ')}.`)
  return parts.length ? `\n\n${parts.join(' ')}` : ''
}

// The saved sprite as text for the prompt.
export function spriteText(name: string, path: string | null, w: number, h: number, palette: string[], frames: number[][], timing: Timing = {}): string {
  const head = `Here is "${name}" from the pixel editor (${w}x${h}, ${colourCount(frames)}${frames.length > 1 ? `, ${frames.length} frames` : ''})` +
    (path ? `. Write it back to ${path}:` : ':')
  return head + gridBlock(w, h, palette, frames).replace(/\n$/, '') + timingText(frames.length, timing) + '\n'
}

// ── exports ──
type ExportMsg = {
  type: 'export'; format: string; frame?: number; w: number; h: number; palette: string[]; frames: string[]; ms: number[]
  layers?: { name: string; frames: string[] }[] | null
}
const FORMATS: Record<string, string> = {
  png: 'a PNG at 1x', png8: 'a PNG at 8x (nearest neighbour)', sheet: 'a PNG sheet of every frame in one row at 1x',
  gif: 'a looping GIF at 8x with these frame times', frames: 'one 8x PNG per frame', ase: 'an Aseprite file', txt: 'a text grid',
}

// Binary files go through the system's base64 decoder (a mod writes only text): sh on macOS and
// Linux, PowerShell on Windows. Each by its full path, with a fixed PATH for sh: a bare name could
// run a same-named program from the project folder (Windows looks in the working directory first).
// False when none of them wrote it whole.
export const WRITERS = {
  sh: '/bin/sh',
  powershell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  pwsh: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
}
async function writeBytes($: EngineInterface, path: string, bytes: Uint8Array): Promise<boolean> {
  const ps = '[IO.File]::WriteAllBytes($env:SF_OUT, [Convert]::FromBase64String([Console]::In.ReadToEnd()))'
  const writers = [
    [WRITERS.sh, '-c', 'base64 --decode > "$SF_OUT"'],
    [WRITERS.powershell, '-NoProfile', '-NonInteractive', '-Command', ps],
    [WRITERS.pwsh, '-NoProfile', '-NonInteractive', '-Command', ps],
  ]
  const stdin = base64(bytes)
  for (const argv of writers) {
    try {
      const env: Record<string, string> = argv[0] === WRITERS.sh ? { SF_OUT: path, PATH: '/usr/bin:/bin' } : { SF_OUT: path }
      const r = await $.process.run(argv, { stdin, env, timeoutMs: 30_000 })
      if (r.exitCode !== 0) continue
      const st = await $.fs.stat(path)
      if (st.kind === 'file' && st.size === bytes.length) return true
    } catch {
      // the next writer
    }
  }
  return false
}

// Writes one export beside the sprite (in the working directory when it came from no file) under
// names nothing has taken yet; says what happened, for the pane.
async function exportFile($: EngineInterface, d: DrawDoc, m: ExportMsg): Promise<string> {
  const palette = m.palette.map((c) => normHex(c) || '#000000')
  const art = { w: m.w, h: m.h, palette, frames: m.frames.map(decodeFrame) }
  const n = art.frames.length, cur = Math.max(0, Math.min(n - 1, Number(m.frame) || 0))
  const ms = art.frames.map((_, i) => Math.max(20, Math.round(Number(m.ms && m.ms[i]) || 125)))
  const dir = d.path && /[\\/]/.test(d.path) ? d.path.replace(/[\\/][^\\/]*$/, '/') : ''
  const base = (d.name || 'sprite').replace(/[^\w.-]+/g, '_').replace(/^\.+/, '') || 'sprite'
  const names = (b: string): [string, () => Uint8Array | string][] => {
    switch (m.format) {
      case 'png': return [[`${b}.png`, () => png(art, [cur], 1)]]
      case 'png8': return [[`${b}@8x.png`, () => png(art, [cur], 8)]]
      case 'sheet': return [[`${b}_sheet.png`, () => png(art, art.frames.map((_, i) => i), 1)]]
      case 'gif': return [[`${b}.gif`, () => gif(art, ms)]]
      case 'frames': return art.frames.map((_, i) => [`${b}_${String(i + 1).padStart(2, '0')}.png`, () => png(art, [i], 8)] as [string, () => Uint8Array])
      case 'ase': {
        const layers = m.layers && m.layers.length ? m.layers.map((L) => ({ name: L.name, frames: L.frames.map(decodeFrame) })) : [{ name: 'Layer 1', frames: art.frames }]
        return [[`${b}.aseprite`, () => ase(m.w, m.h, palette, layers, ms)]]
      }
      case 'txt': return [[`${b}.txt`, () => asciiArt(d.name, art)]]
      default: throw new Error(`unknown format ${m.format}`)
    }
  }
  // A set of names none of which is there yet: hero.png, else hero-2.png, hero-3.png...
  let files = names(base)
  for (let k = 2; k < 100; k++) {
    const taken = await Promise.all(files.map(([f]) => $.fs.exists(dir + f).catch(() => false)))
    if (!taken.some(Boolean)) break
    files = names(`${base}-${k}`)
  }
  const written: string[] = []
  for (const [f, make] of files) {
    const body = make(), path = dir + f
    if (typeof body === 'string') await $.fs.write(path, body)
    else if (!(await writeBytes($, path, body))) {
      // No decoder here: hand the pixels to Claude to write instead.
      const text = `Write "${d.name}" to ${path} as ${FORMATS[m.format] || m.format}:` + gridBlock(m.w, m.h, palette, art.frames).replace(/\n$/, '') +
        timingText(n, { ms }) + '\n'
      const draft = await $.prompt.read()
      await $.prompt.fill({ text: draft.text.trim() ? `\n\n${text}` : text, mode: draft.text.trim() ? 'append' : 'replace' })
      return `Couldn't write ${path} here (no base64 tool): it's in your prompt for Claude to write.`
    }
    written.push(path)
  }
  return written.length > 2 ? `Wrote ${written.length} files: ${written[0]} ... ${written[written.length - 1]}.` : `Wrote ${written.join(' and ')}.`
}

// The saved tileset as text for the prompt: one sheet, laid out as it came (a strip stays a
// strip, anything else is SpriteForge's 4x4 sheet), with what the tile order means.
export function tilesText(d: Pick<TileDoc, 'name' | 'path' | 'source'> & { kind?: TileDoc['kind'] }, T: number, palette: string[], tiles: number[][]): string {
  if (d.kind === 'platformer') return platformerText(d, T, palette, tiles)
  const across = d.source === 'strip' ? TILES : 4, w = across * T, sheetH = (TILES / across) * T
  const sheet = new Array<number>(w * sheetH).fill(-1)
  tiles.forEach((t, m) => {
    const ox = (m % across) * T, oy = Math.floor(m / across) * T
    for (let j = 0; j < T; j++) for (let i = 0; i < T; i++) sheet[(oy + j) * w + ox + i] = t[j * T + i]!
  })
  const where = d.path && (d.source === 'sheet' || d.source === 'strip') ? ` Write it back to ${d.path}:`
    : d.path ? ` It was made from the texture ${d.path}, which stays as it is; save the set as a new PNG beside it:` : ''
  const head = `Here is the Wang tileset "${d.name}" from the tile editor: 16 tiles of ${T}x${T}, ${colourCount(tiles)}, as a ${across === 4 ? '4x4 sheet' : '16x1 strip'} (${w}x${sheetH}). ` +
    `Tile i (left to right, top to bottom, from 0) is drawn where the map cells at its corners are painted, NW=1 + NE=2 + SW=4 + SE=8; tile 15 is the base texture.` + (where || '')
  return head + gridBlock(w, sheetH, palette, [sheet])
}

// A platformer set as one 7x7 sheet.
function platformerText(d: Pick<TileDoc, 'name' | 'path' | 'source'>, T: number, palette: string[], tiles: number[][]): string {
  const w = SHEET * T, sheet = new Array<number>(w * w).fill(-1)
  tiles.forEach((t, m) => {
    const ox = (m % SHEET) * T, oy = Math.floor(m / SHEET) * T
    for (let j = 0; j < T; j++) for (let i = 0; i < T; i++) sheet[(oy + j) * w + ox + i] = t[j * T + i]!
  })
  const where = d.path && d.source === 'sheet' ? ` Write it back to ${d.path}:` : ''
  const head = `Here is the platformer tileset "${d.name}" from the tile editor: 49 tiles of ${T}x${T}, ${colourCount(tiles)}, as a 7x7 sheet (${w}x${w}) ` +
    `in SpriteForge's platformer order (47 blob autotiles, then 2 slopes; left to right, top to bottom).` + where
  return head + gridBlock(w, w, palette, [sheet])
}

function parseArgs(args: string): OpenSpec {
  const a = args.trim()
  if (!a) return { width: 16, height: 16 }
  const m = /^(\d{1,3})\s*[x×]\s*(\d{1,3})$/i.exec(a)
  if (m) return { width: Number(m[1]), height: Number(m[2]) }
  return { path: a.replace(/^["']|["']$/g, '') }
}

type TileSpec = {
  kind?: 'wang' | 'wall' | 'iso' | 'platformer'
  path?: string
  layout?: 'sheet' | 'strip' | 'texture'
  palette?: string[]
  tiles?: number[][][]
  base?: number[][]
  size?: number
  name?: string
}

function checkTile(T: number, what: string) {
  if (!Number.isInteger(T) || T < MIN_TILE || T > MAX_TILE) throw new Error(`${what}: tiles can be ${MIN_TILE}-${MAX_TILE} pixels square.`)
}

function hexPalette(p: unknown[] | undefined): string[] {
  const palette = (p || []).map((c, i) => {
    const hx = normHex(c)
    if (!hx) throw new Error(`palette[${i}] isn't a hex colour like "#a1b2c3".`)
    return hx
  })
  if (palette.length > MAX_COLORS) throw new Error(`At most ${MAX_COLORS} colours.`)
  return palette
}

// A PNG as a set: a platformer set's 7x7 sheet; for a Wang set a 16x1 strip, a 4x4 sheet (its
// first tile, mask 0, is empty and its last, the base, is not), or else a square texture the set
// is made from.
function tilesFromPng(bytes: Uint8Array, path: string, layout: TileSpec['layout'], platformer = false) {
  const s = spriteFromPng(bytes, MAX_TILE * TILES, MAX_COLORS)
  if (platformer) {
    if (s.w !== s.h || s.w % SHEET) throw new Error(`${path} is ${s.w}x${s.h}: a platformer set is a 7x7 sheet of square tiles.`)
    const T = s.w / SHEET
    checkTile(T, path)
    const tiles = Array.from({ length: PLATFORMER }, (_, m) => Array.from({ length: T * T }, (_, i) => s.grid[(Math.floor(m / SHEET) * T + Math.floor(i / T)) * s.w + (m % SHEET) * T + (i % T)]!))
    return { source: 'sheet' as const, T, palette: s.palette, tiles }
  }
  const tileOf = (across: number, T: number, m: number) => {
    const ox = (m % across) * T, oy = Math.floor(m / across) * T
    return Array.from({ length: T * T }, (_, i) => s.grid[(oy + Math.floor(i / T)) * s.w + ox + (i % T)]!)
  }
  let kind = layout
  if (!kind) {
    if (s.w === TILES * s.h) kind = 'strip'
    else if (s.w === s.h && s.w % 4 === 0 && s.w >= 4 * MIN_TILE && tileOf(4, s.w / 4, 0).every((v) => v < 0) && tileOf(4, s.w / 4, BASE).some((v) => v >= 0)) kind = 'sheet'
    else if (s.w === s.h) kind = 'texture'
    else throw new Error(`${path} is ${s.w}x${s.h}: a Wang set is a 4x4 sheet or a 16x1 strip of square tiles, and a texture to make one from is square.`)
  }
  const T = kind === 'strip' ? s.h : kind === 'sheet' ? s.w / 4 : s.w
  const fits = kind === 'strip' ? s.w === TILES * s.h : kind === 'sheet' ? s.w === s.h && s.w % 4 === 0 : s.w === s.h
  if (!fits) throw new Error(`${path} is ${s.w}x${s.h}, which isn't a ${kind === 'texture' ? 'square texture' : kind === 'sheet' ? '4x4 sheet of square tiles' : '16x1 strip of square tiles'}.`)
  checkTile(T, path)
  const tiles = kind === 'texture' ? deriveTiles(s.grid, T) : Array.from({ length: TILES }, (_, m) => tileOf(kind === 'strip' ? TILES : 4, T, m))
  return { source: kind, T, palette: s.palette, tiles }
}

async function buildTileDoc($: EngineInterface, spec: TileSpec): Promise<TileDoc> {
  const prev = await read($, tileset)
  const rev = (prev ? prev.rev : 0) + 1
  if (spec.kind !== undefined && !['wang', 'wall', 'iso', 'platformer'].includes(spec.kind)) throw new Error('kind must be wang, wall, iso or platformer.')
  const platformer = spec.kind === 'platformer'
  const kind = platformer ? 'platformer' as const : 'wang' as const, view = spec.kind === 'wall' ? 'wall' as const : spec.kind === 'iso' ? 'iso' as const : 'flat' as const
  if (spec.path) {
    const path = String(spec.path)
    let bytes: Uint8Array
    try {
      const r = await $.fs.read(path, { as: 'bytes' })
      bytes = base64Bytes(r.base64)
    } catch (e) {
      throw new Error(`Couldn't read ${path}: ${(e as Error).message}`)
    }
    const t = tilesFromPng(bytes, path, spec.layout, platformer)
    return { rev, name: spec.name || baseName(path), path, kind, view, source: t.source, tile: t.T, palette: t.palette, tiles: t.tiles.map(encodeFrame) }
  }
  if (platformer && spec.base) throw new Error('A platformer set takes tiles (49 grids), a path or a size; base is for Wang sets.')
  if (spec.tiles || spec.base) {
    const palette = hexPalette(spec.palette)
    let tiles: number[][], T: number
    if (spec.tiles) {
      const n = platformer ? PLATFORMER : TILES
      if (!Array.isArray(spec.tiles) || spec.tiles.length !== n) {
        throw new Error(platformer ? `tiles must be ${PLATFORMER} grids, in SpriteForge's platformer order.` : `tiles must be ${TILES} grids, tile i drawn where the map cells at its corners are painted (NW=1, NE=2, SW=4, SE=8).`)
      }
      const grids = spec.tiles.map((g, i) => checkGrid(g, palette.length, `tiles[${i}]`))
      T = grids[0]!.length
      if (grids.some((g) => g.length !== T || g[0]!.length !== T)) throw new Error('Every tile must be the same square size.')
      tiles = grids.map((g) => g.flat())
    } else {
      const g = checkGrid(spec.base, palette.length, 'base')
      T = g.length
      if (g[0]!.length !== T) throw new Error('base must be square.')
      tiles = deriveTiles(g.flat(), T)
    }
    checkTile(T, spec.tiles ? 'tiles' : 'base')
    return { rev, name: spec.name || 'tileset', path: null, kind, view, source: 'draft', tile: T, palette, tiles: tiles.map(encodeFrame) }
  }
  const T = Math.round(Number(spec.size) || 16)
  checkTile(T, 'size')
  if (platformer) {
    return { rev, name: spec.name || 'ground', path: null, kind, view, source: 'blank', tile: T, palette: PICO8.slice(), tiles: new Array(PLATFORMER).fill(encodeFrame(new Array(T * T).fill(-1))) }
  }
  return { rev, name: spec.name || 'grass', path: null, kind, view, source: 'blank', tile: T, palette: GRASS.slice(), tiles: deriveTiles(grassBase(T), T).map(encodeFrame) }
}

async function openTiles($: EngineInterface, spec: TileSpec) {
  const d = await buildTileDoc($, spec)
  await update($, tileset, () => d)
  const placed = await $.ui.open({ id: TILES_PANE, title: `Tile editor: ${d.name}`, focus: true, rows: 44 })
  if (placed.isPlaced) return { doc: d, isPlaced: true, why: '' }
  const surfaces = await $.session.surfaces().catch(() => [] as readonly string[])
  return { doc: d, isPlaced: false, why: `${placed.reason}; surfaces attached: ${surfaces.length ? surfaces.join(', ') : 'none'}` }
}

function tileSpecFrom(e: Record<string, unknown>): TileSpec {
  const src = (e.input && typeof e.input === 'object' ? e.input : e) as Record<string, unknown>
  const spec: TileSpec = {}
  for (const k of ['kind', 'path', 'layout', 'palette', 'tiles', 'base', 'size', 'name'] as const) {
    if (src[k] !== undefined) (spec as Record<string, unknown>)[k] = src[k]
  }
  return spec
}

// "[file.png | size] [wang | wall | iso | platformer]", either part optional.
function parseTileArgs(args: string): TileSpec {
  let a = args.trim()
  const spec: TileSpec = {}
  const k = /(?:^|\s)(wang|walls?|iso|isometric|platformer)$/i.exec(a)
  if (k) {
    const w = k[1]!.toLowerCase()
    spec.kind = w.startsWith('wall') ? 'wall' : w.startsWith('iso') ? 'iso' : (w as 'wang' | 'platformer')
    a = a.slice(0, a.length - k[0].length).trim()
  }
  if (!a) spec.size = 16
  else if (/^\d{1,3}$/.test(a)) spec.size = Number(a)
  else spec.path = a.replace(/^["']|["']$/g, '')
  return spec
}

const tilesWhat = (d: TileDoc) =>
  `"${d.name}" (${d.kind === 'platformer' ? 'a platformer set: 49' : d.view === 'wall' ? 'Wang walls: 16' : d.view === 'iso' ? 'isometric Wang: 16' : '16'} tiles of ${d.tile}x${d.tile}, ${d.palette.length} colours)`
const GRID_SCHEMA = { type: 'array', items: { type: 'array', items: { type: 'integer' } } }

// The terminal's main screen gives a pane no mouse clicks; its fullscreen layout does. The layout is fixed
// per session and every drawing's viewport says which it is, so it's noted from there. Switching
// (/tui fullscreen) changes a setting kept for later sessions, so Claude asks first, once ever (kept in
// $.store), and the switch waits for the turn's end: a command can't run inside a hook the turn waits
// on. The panes themselves say how to switch while on the main screen, asked or not.
const FULLSCREEN_TOOL = 'enter_fullscreen'
const ASKED_KEY = 'fullscreenAsked'
let mainScreen = false
let switchPending = false
// The store when there is one, else this load's memory.
let askedHere = false
const noteScreen = (e: { surface: string; viewport?: { isFullscreen?: boolean } }) => {
  if (e.surface === 'terminal' && e.viewport?.isFullscreen !== undefined) mainScreen = !e.viewport.isFullscreen
}
const onMainScreen = (e: { surface: string; viewport?: { isFullscreen?: boolean } }) => e.surface === 'terminal' && e.viewport?.isFullscreen === false
const MAIN_SCREEN_ASK =
  ' Claude Code is on its main screen here, where a pane gets no mouse clicks: the user can look at the editor but not draw in it. ' +
  "Ask the user whether to switch Claude Code to its fullscreen layout (what /tui fullscreen does: the screen redraws, the conversation stays, and it's kept for later sessions). " +
  'Put that question last in your reply, as its own short paragraph after everything else, so it is not buried. ' +
  `Only if they say yes, call ${FULLSCREEN_TOOL}; if not, tell them they can type /tui fullscreen themselves later.`
const MAIN_SCREEN_ASKED =
  ' Claude Code is on its main screen here, where a pane gets no mouse clicks. The user was already offered fullscreen once and the pane tells them to type /tui fullscreen: ' +
  `don't offer it again. Call ${FULLSCREEN_TOOL} only if they ask you to switch.`
const MAIN_SCREEN_COMMAND = ' This terminal is on its main screen, where a pane gets no mouse clicks: type /tui fullscreen to draw in it.'
const MAIN_SCREEN_HINT = 'Clicks need the fullscreen layout: type /tui fullscreen to draw here.'

// What a tool result adds on the main screen: the offer the first time ever, a note after.
async function mainScreenNote($: EngineInterface): Promise<string> {
  if (!mainScreen) return ''
  let asked = askedHere
  try {
    asked = asked || (await $.store.get(ASKED_KEY)) === true
  } catch {
    // no store: this load's memory alone
  }
  if (asked) return MAIN_SCREEN_ASKED
  askedHere = true
  await $.store.set(ASKED_KEY, true).catch(() => undefined)
  return MAIN_SCREEN_ASK
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'spriteforge-draw',
      description: 'Open the pixel editor beside the conversation (a PNG file, or a blank WxH canvas)',
      argumentHint: '[file.png | WxH]',
    })
    await $.tool.register({
      name: TOOL,
      description:
        'Open a pixel-art editor in a pane beside the conversation so the user can edit a sprite by hand with the mouse. ' +
        'Give one source: path (a PNG file in the project, up to 64x64 and 256 colours), palette + grid (pixel art you drafted: ' +
        'hex colours and rows of palette indexes, -1 transparent; frames for an animation), or width + height for a blank canvas. ' +
        'It returns at once. When the user clicks "Send to Claude", their prompt box is filled with the edited sprite as a GRID ' +
        '(one letter per pixel, "." transparent) + PALETTE block for them to send to you; write it back to the file if they ask.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'A PNG file to open, relative to the working directory or absolute.' },
          palette: { type: 'array', items: { type: 'string' }, description: 'Hex colours, for art you drafted.' },
          grid: { type: 'array', items: { type: 'array', items: { type: 'integer' } }, description: 'Rows of palette indexes, -1 transparent.' },
          frames: { type: 'array', items: { type: 'object', properties: { grid: { type: 'array', items: { type: 'array', items: { type: 'integer' } } } }, required: ['grid'] }, description: 'Animation frames on the same palette, instead of grid.' },
          width: { type: 'integer', minimum: 1, maximum: MAX_SIDE, description: 'Blank canvas width.' },
          height: { type: 'integer', minimum: 1, maximum: MAX_SIDE, description: 'Blank canvas height.' },
          name: { type: 'string', description: 'What to call the sprite.' },
        },
        additionalProperties: false,
      },
      isDeferred: false,
    })
    await $.command.register({
      name: 'spriteforge-tiles',
      description: 'Open the tile editor beside the conversation (a Wang or platformer tileset PNG, a texture to make a Wang set from, or a tile size)',
      argumentHint: '[tiles.png | texture.png | size] [wall | iso | platformer]',
    })
    await $.tool.register({
      name: TILES_TOOL,
      description:
        "Open SpriteForge's tile editor in a pane beside the conversation, for a 16-tile Wang (dual-grid autotile) terrain set " +
        '(kind wang; wall or iso preview it as walls or isometric) or a 49-tile platformer set (kind platformer): for a Wang set the ' +
        'user paints a small map to see the tiles chain, draws on the map or on single tiles, and edits the base texture, which ' +
        're-derives the edge tiles; a platformer set is edited on its sheet and tile by tile. Give one source: path (a tileset PNG as ' +
        "SpriteForge exports it: a Wang set's 4x4 sheet or 16x1 strip, a platformer set's 7x7 sheet; or a square seamless texture to " +
        'make a Wang set from), palette + tiles (Wang: 16 grids in mask order, tile i drawn where the map cells at its corners are ' +
        "painted, NW=1 NE=2 SW=4 SE=8, so 15 is the solid base; platformer: 49 grids in SpriteForge's order), palette + base (one " +
        'seamless texture grid; the 16 Wang tiles are derived from it as SpriteForge does), or size for a placeholder. It returns at ' +
        'once. When the user clicks "Send to Claude", their prompt box is filled with the set as one GRID sheet + PALETTE for them to send to you.',
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['wang', 'wall', 'iso', 'platformer'], description: 'wang (default), wall or iso (a Wang set previewed as walls or isometric), or platformer.' },
          path: { type: 'string', description: 'A tileset sheet or strip PNG, or a square texture PNG, relative to the working directory or absolute.' },
          layout: { type: 'string', enum: ['sheet', 'strip', 'texture'], description: 'How to read path, when its shape leaves it open (a square image is a sheet when its first tile is empty).' },
          palette: { type: 'array', items: { type: 'string' }, description: 'Hex colours, for tiles or base.' },
          tiles: { type: 'array', items: GRID_SCHEMA, minItems: TILES, maxItems: PLATFORMER, description: "16 tile grids in mask order (Wang) or 49 in SpriteForge's order (platformer), palette indexes, -1 transparent." },
          base: { ...GRID_SCHEMA, description: 'A square seamless texture grid to derive the 16 tiles from.' },
          size: { type: 'integer', minimum: MIN_TILE, maximum: MAX_TILE, description: 'Tile size for a placeholder set (Wang: grass; platformer: blank).' },
          name: { type: 'string', description: 'What to call the set.' },
        },
        additionalProperties: false,
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: FULLSCREEN_TOOL,
      description:
        "Switch Claude Code's terminal to its fullscreen layout (/tui fullscreen), where the SpriteForge editor panes take mouse clicks. " +
        'Call it only after the user has said yes to switching, never on your own: it changes a setting kept for later sessions. ' +
        'The switch happens once your turn ends.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      isDeferred: false,
    })
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
    noteScreen(e)
    return next(e)
  })

  on('tool.call', { tool: 'mcp__spriteforge-editor__enter_fullscreen' }, async () => {
    if (!mainScreen) return { result: 'Claude Code is not on the main screen of a terminal here (it is already fullscreen, or another surface); nothing to switch.' }
    switchPending = true
    return { result: 'Claude Code switches to its fullscreen layout as soon as this turn ends. End the turn now with one short line; once the screen has redrawn, open the editor again if the user wants it.' }
  }).catch(() => ({ result: "Couldn't switch to fullscreen; the user can type /tui fullscreen.", isError: true as const }))

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (switchPending && e.agentId === undefined) {
      switchPending = false
      void $.command.run({ command: 'tui', args: 'fullscreen' })
        .catch((err: Error) => $.ui.toast(`Couldn't switch to fullscreen (${err.message}): type /tui fullscreen instead.`))
    }
    return r
  })

  on('command.run', { command: 'spriteforge-tiles' }, async ($, e) => {
    try {
      const r = await openTiles($, parseTileArgs(e.args))
      return {
        text: (r.isPlaced
          ? `Opened ${tilesWhat(r.doc)} in the tile editor. ${r.doc.kind === 'platformer' ? 'Click a tile to edit it' : 'Paint the map to see the tiles chain'}; "Send to Claude" puts the set in your prompt.`
          : `Loaded ${tilesWhat(r.doc)}, but nothing here can show the tile editor pane (${r.why}). It needs Claude Code in a terminal or the desktop app.`) +
          (mainScreen ? MAIN_SCREEN_COMMAND : ''),
      }
    } catch (err) {
      return { text: `Couldn't open the tile editor: ${(err as Error).message}` }
    }
  })

  on('tool.call', { tool: 'mcp__spriteforge-editor__open_tile_editor' }, async ($, e) => {
    try {
      const r = await openTiles($, tileSpecFrom(e as unknown as Record<string, unknown>))
      return {
        result: (r.isPlaced
          ? `Opened ${tilesWhat(r.doc)} in the tile editor beside the conversation. The user edits it there; when they click "Send to Claude", the set arrives in their next message as one GRID sheet + PALETTE. Wait for it.`
          : `Loaded ${tilesWhat(r.doc)}, but no surface here can show the tile editor pane (${r.why}); Claude Code in a terminal or the desktop app can. Tell the user.`) +
          (await mainScreenNote($)),
      }
    } catch (err) {
      return { result: `Couldn't open the tile editor: ${(err as Error).message}`, isError: true as const }
    }
  }).catch(() => ({ result: 'The tile editor hit an internal error; try /spriteforge-tiles instead.', isError: true as const }))

  on('ui.message', { element: 'tiles' }, async ($, e, next) => {
    const data = e.data as { type?: string; tile?: number; palette?: string[]; tiles?: string[]; mask?: number; art?: string } | null
    const d = await read($, tileset)
    if (data && data.type === 'studio' && d && typeof data.art === 'string' && Array.isArray(data.palette)) {
      // A tile to the pixel editor; its "Back to tiles" returns it (the 'back' message below).
      const mask = Number(data.mask), prevDoc = await read($, doc)
      const draw: DrawDoc = {
        rev: (prevDoc ? prevDoc.rev : 0) + 1, name: `${d.name} tile ${mask}`, path: null, w: d.tile, h: d.tile,
        palette: data.palette.map((c) => normHex(c) || '#000000'), frames: [data.art], back: { mask, tilesRev: d.rev },
      }
      await update($, doc, () => draw)
      await $.ui.open({ id: PANE, title: `Pixel editor: ${draw.name}`, focus: true, rows: Math.min(60, Math.ceil(d.tile / (d.tile > 40 ? 2 : 1)) + CONTROL_ROWS + 1) })
      return next(e)
    }
    if (!data || data.type !== 'save' || !d || !Array.isArray(data.tiles) || !Array.isArray(data.palette)) return next(e)
    const T = Number(data.tile)
    const tiles = data.tiles.map(decodeFrame)
    if (tiles.length !== (d.kind === 'platformer' ? PLATFORMER : TILES) || tiles.some((t) => t.length !== T * T)) return next(e)
    const text = tilesText(d, T, data.palette.map((c) => normHex(c) || '#000000'), tiles)
    const draft = await $.prompt.read()
    await $.prompt.fill({ text: draft.text.trim() ? `\n\n${text}` : text, mode: draft.text.trim() ? 'append' : 'replace' })
    await update($, tileset, (cur) => (cur && cur.rev === d.rev ? { ...cur, palette: data.palette!.slice(), tiles: data.tiles!.slice() } : cur))
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: TILES_PANE }, async ($, e) => {
    noteScreen(e)
    const d = await read($, tileset)
    if (e.surface !== 'terminal' && e.surface !== 'desktop') {
      const { Text } = $.ui.resolve(e)
      return <Text>The tile editor needs Claude Code in a terminal or the desktop app.</Text>
    }
    const { Box, Text, Link, Client } = $.ui.resolve(e)
    if (!d) return <Text dimColor>No tileset is open. Run /spriteforge-tiles to start one.</Text>
    const rows = Math.max(8, (e.props.scroll.bodyRows || 30) - TILES_CONTROL_ROWS - (onMainScreen(e) ? 1 : 0))
    return (
      <Box flexDirection="column">
        <Box key="head" columnGap={2}>
          <Text key="what" wrap="truncate-end">
            <Link href={SITE}><Text bold color={GOLD}>SpriteForge.tech</Text></Link>
            <Text dimColor> · </Text>
            <Text bold>{d.name}</Text>
            <Text dimColor>{` ${d.kind === 'platformer' ? 49 : 16} tiles of ${d.tile}x${d.tile}${d.path ? ` · ${d.path}` : ''} · ${d.kind === 'platformer' ? 'edit the sheet or a tile' : 'paint the map, edit tiles'}, then Send to Claude`}</Text>
          </Text>
        </Box>
        {onMainScreen(e) ? <Text key="tui" color={GOLD} wrap="truncate-end">{MAIN_SCREEN_HINT}</Text> : null}
        <Client key="tiles" module="./tiles.tsx" props={{ doc: d, cols: e.props.bodyColumns, rows, back: await read($, tileBack), surface: e.surface }} width="100%" />
      </Box>
    )
  })

  on('command.run', { command: 'spriteforge-draw' }, async ($, e) => {
    try {
      const r = await open($, parseArgs(e.args))
      const what = `${r.doc.name} (${r.doc.w}x${r.doc.h})`
      return {
        text: (r.isPlaced
          ? `Opened ${what} in the pixel editor. Draw with the mouse; "Send to Claude" puts the result in your prompt.`
          : `Loaded ${what}, but nothing here can show the editor pane (${r.why}). It needs Claude Code in a terminal or the desktop app.`) +
          (mainScreen ? MAIN_SCREEN_COMMAND : ''),
      }
    } catch (err) {
      return { text: `Couldn't open the pixel editor: ${(err as Error).message}` }
    }
  })

  on('tool.call', { tool: 'mcp__spriteforge-editor__open_pixel_editor' }, async ($, e) => {
    try {
      const r = await open($, specFrom(e as unknown as Record<string, unknown>))
      const what = `"${r.doc.name}" (${r.doc.w}x${r.doc.h}, ${r.doc.palette.length} colours${r.doc.frames.length > 1 ? `, ${r.doc.frames.length} frames` : ''})`
      return {
        result: (r.isPlaced
          ? `Opened ${what} in the pixel editor beside the conversation. The user edits it there; when they click "Send to Claude", the sprite arrives in their next message as a GRID + PALETTE block. Wait for it.`
          : `Loaded ${what}, but no surface here can show the editor pane (${r.why}); Claude Code in a terminal or the desktop app can. Tell the user.`) +
          (await mainScreenNote($)),
      }
    } catch (err) {
      return { result: `Couldn't open the pixel editor: ${(err as Error).message}`, isError: true as const }
    }
  }).catch(() => ({ result: "The pixel editor hit an internal error; try /spriteforge-draw instead.", isError: true as const }))

  on('ui.message', { element: 'editor' }, async ($, e, next) => {
    const data = e.data as { type?: string; w?: number; h?: number; palette?: string[]; frames?: string[] } & Timing | null
    const d = await read($, doc)
    if (!data || !['save', 'export', 'back'].includes(String(data.type)) || !d || !Array.isArray(data.frames) || !Array.isArray(data.palette)) return next(e)
    const w = Number(data.w), h = Number(data.h)
    const frames = data.frames.map(decodeFrame).filter((f) => f.length === w * h)
    if (!frames.length || frames.length !== data.frames.length) return next(e)
    if (data.type === 'back') {
      // The tile goes back to the tile editor, if the set it came from is still the one open.
      const t = await read($, tileset)
      if (!d.back || !t || t.rev !== d.back.tilesRev || w !== t.tile || h !== t.tile) {
        await update($, notice, (cur) => ({ id: (cur ? cur.id : 0) + 1, text: 'The tileset this tile came from is no longer open: Send to Claude instead.' }))
        return next(e)
      }
      const mask = d.back.mask
      await update($, tileBack, (cur) => ({ id: (cur ? cur.id : 0) + 1, mask, palette: data.palette!.map((c) => normHex(c) || '#000000'), art: data.frames![0]! }))
      await $.ui.open({ id: TILES_PANE, title: `Tile editor: ${t.name}`, focus: true, rows: 44 })
      return next(e)
    }
    if (data.type === 'export') {
      let text: string
      try {
        text = await exportFile($, d, data as unknown as ExportMsg)
      } catch (err) {
        text = `Couldn't export: ${(err as Error).message}`
      }
      await update($, notice, (cur) => ({ id: (cur ? cur.id : 0) + 1, text }))
      return next(e)
    }
    const text = spriteText(d.name, d.path, w, h, data.palette.map((c) => normHex(c) || '#000000'), frames, { ms: data.ms, tags: data.tags })
    const draft = await $.prompt.read()
    await $.prompt.fill({ text: draft.text.trim() ? `\n\n${text}` : text, mode: draft.text.trim() ? 'append' : 'replace' })
    // Keep what was saved, so reopening the pane shows the latest pixels.
    await update($, doc, (cur) => (cur && cur.rev === d.rev ? { ...cur, palette: data.palette!.slice(), frames: data.frames!.slice() } : cur))
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    noteScreen(e)
    const d = await read($, doc)
    if (e.surface !== 'terminal' && e.surface !== 'desktop') {
      const { Text } = $.ui.resolve(e)
      return <Text>The pixel editor needs Claude Code in a terminal or the desktop app.</Text>
    }
    const { Box, Text, Link, Client } = $.ui.resolve(e)
    if (!d) return <Text dimColor>No sprite is open. Run /spriteforge-draw to start one.</Text>
    const rows = Math.max(8, (e.props.scroll.bodyRows || 30) - CONTROL_ROWS - (onMainScreen(e) ? 1 : 0))
    const note = await read($, notice)
    return (
      <Box flexDirection="column">
        <Box key="head" columnGap={2}>
          <Text key="what" wrap="truncate-end">
            <Link href={SITE}><Text bold color={GOLD}>SpriteForge.tech</Text></Link>
            <Text dimColor> · </Text>
            <Text bold>{d.name}</Text>
            <Text dimColor>{` ${d.w}x${d.h}${d.path ? ` · ${d.path}` : ''}`}</Text>
          </Text>
        </Box>
        {onMainScreen(e) ? <Text key="tui" color={GOLD} wrap="truncate-end">{MAIN_SCREEN_HINT}</Text> : null}
        <Client key="editor" module="./editor.tsx" props={{ doc: d, cols: e.props.bodyColumns, rows, notice: note, surface: e.surface }} width="100%" />
      </Box>
    )
  })
}
