import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { flood } from '../hooks/pixels'
import { tilesText } from '../hooks/register'
import { deriveTiles, shadeHex } from '../hooks/wang'

const PLUGIN = 'spriteforge-editor'
const PANE = 'spriteforge-tiles'
const TOOL = 'mcp__spriteforge-editor__open_tile_editor'
const SURFACES = ['terminal', 'desktop'] as const
// Made by SpriteForge's own engine (app/engine/wang.js) from an 8x8 three-colour texture: its 16
// tiles as a 4x4 sheet and as a 16x1 strip, the texture, and an image of no tileset shape. The
// ROWS are the sheet and strip in the colours a, b, c of FIXTURE_PALETTE.
const FIXTURE_PALETTE = ['#6ea8fe', '#dcb684', '#17161d']
const SHEET_PNG = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAA90lEQVR4nO1WwQ3CMAzMFPBixU7BMEzANMzSIJAshcj2neMGFVG/rDiNz3ex01KALbe1Pu7Xej5dqvje/n6v9j171ttCmxXAVmLx4YFhxB0Ir/qXTx3GJLVApCXIWC+BrIs/Wtxh37VdzQGvd9uLNXUOeL2r7YVzAKFAiNs1LQmUAFGBqtfirRxQAnQpRuJtQfACWug9WrPxD9ZHKGYl0OLhN+Bn5oAFeP9zACWPUDg0B6zEhe3jGRJoFDEUbiKBRVHbYtHBREuAKJodh3Kg3t3sEiLUDPVT50Cvr1V9+H9A/AiF2bhJMUthNu5SzFCYjbvv9V9I8ATqD9GNxB9F0gAAAABJRU5ErkJggg=='
const STRIP_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAIAAAAAICAYAAAAx3fd+AAAA6klEQVR4nO1VSw5CMQjkFLp6V/QUHsYTeBrP8mpcNGmQ30CfNUZWTQYYWmBK5NjltrfH/drOp631s+XPfaX4aK4/P8Yv+Vb5CXIWitCI+xnht2J6fav4P3l/qRda/ir/W2I3gD2CNX2vM8pvxUi+v8g/9kIb/Fn8FJoSJS4iQehGWfXNlkA0PsPP6ye29ZH4Co72FTIuQePDclzL4U2shEv5EQmsxKMSvBrPd3eSoX9bBB8vlpl+aeAiEpqR4NV4tX9l07ZXwqOy6+He9ku5xvrQgTxSwr/6C4hYRuI9nDcuenFvSI7AV38BT2p20Y1MRqtUAAAAAElFTkSuQmCC'
const TEXTURE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAJUlEQVR4nGPIW/Hv/51tLf/FxWT/Y2Mz4JKAsRnw6QaxGYaCFQBH5p9Z40CGsAAAAABJRU5ErkJggg=='
const ODD_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAoAAAAGCAYAAAD68A/GAAAAE0lEQVR4nGPIW/HvPzGYYTgpBABozLh1gHQvxwAAAABJRU5ErkJggg=='
const SHEET_ROWS = [
  '........abcab.......bcababcabcab',
  '........cab.........abcacabcabca',
  '........bcab.........abcbcabcabc',
  '........a.............ababcabcab',
  '.......................acab..b.a',
  '................................',
  '................................',
  '................................',
  '........abcab.......bcababcabcab',
  '........cabca.....b.abcacabcabca',
  '........bcabc......bcabcbcabcabc',
  'a.......abca....a..abcababcabcab',
  'ca......cabc....cabc.b.acabcabca',
  'bcab....bcab....bcab.a..bcabcab.',
  'abc.b...abcab...abcab...abcabca.',
  'cabc....cabc....cabc.b..cabcab..',
  '........abcab.......bcababcabcab',
  '........cabca.......abcacabcabca',
  '........bcabc......bcabcbcabcabc',
  '.......babcabcab...abcababcabcab',
  '.....b.acabcabca....abcacabcabca',
  '.....abc..abcabc...bcabcbcabcabc',
  '....bcab..c.bcab....bcab.bcabcab',
  '...cabca...cabca...cabca...cabca',
  '........abcab......abcababcabcab',
  '........cabcab....bcabcacabcabca',
  '........bcabcab.b.abcabcbcabcabc',
  'a..a.cababcabcababcabcababcabcab',
  'cabcabcacabcabcacabcabcacabcabca',
  'bcabcabcbcabcabcbcabcabcbcabcabc',
  'abcabcababcabcababcabcababcabcab',
  'cabcabcacabcabcacabcabcacabcabca',
]
const STRIP_ROWS = [
  '........abcab.......bcababcabcab........abcab.......bcababcabcab........abcab.......bcababcabcab........abcab......abcababcabcab',
  '........cab.........abcacabcabca........cabca.....b.abcacabcabca........cabca.......abcacabcabca........cabcab....bcabcacabcabca',
  '........bcab.........abcbcabcabc........bcabc......bcabcbcabcabc........bcabc......bcabcbcabcabc........bcabcab.b.abcabcbcabcabc',
  '........a.............ababcabcaba.......abca....a..abcababcabcab.......babcabcab...abcababcabcaba..a.cababcabcababcabcababcabcab',
  '.......................acab..b.aca......cabc....cabc.b.acabcabca.....b.acabcabca....abcacabcabcacabcabcacabcabcacabcabcacabcabca',
  '................................bcab....bcab....bcab.a..bcabcab......abc..abcabc...bcabcbcabcabcbcabcabcbcabcabcbcabcabcbcabcabc',
  '................................abc.b...abcab...abcab...abcabca.....bcab..c.bcab....bcab.bcabcababcabcababcabcababcabcababcabcab',
  '................................cabc....cabc....cabc.b..cabcab.....cabca...cabca...cabca...cabcacabcabcacabcabcacabcabcacabcabca',
]
const FILES: Record<string, string> = { 'sheet.png': SHEET_PNG, 'strip.png': STRIP_PNG, 'tex.png': TEXTURE_PNG, 'odd.png': ODD_PNG }

const run = ($: { command: { run: (i: never) => Promise<{ text?: string }> } }, args: string) =>
  $.command.run({ command: 'spriteforge-tiles', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as never)

const pane = (cols: number, rows: number) => ({
  title: 'Tile editor', isFocused: true, bodyColumns: cols, placement: 'inline' as const,
  scroll: { offset: 0, bodyRows: rows }, view: {},
})

function host(on: On) {
  const filled: { text: string; mode: string }[] = []
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('prompt.fill', (_$, e) => {
    filled.push({ text: e.text, mode: e.mode })
    return { isFilled: true }
  })
  on('fs.read', (_$, e) => {
    const name = String((e as { path?: unknown }).path).split(/[\\/]/).pop()!
    if (FILES[name]) return { value: { base64: FILES[name] } }
    throw new Error('ENOENT: no such file')
  })
  return filled
}

const gridOf = (text: string) => text.split('GRID\n')[1]!.split('\n\nPALETTE')[0]!.split('\n')
// The saved grid in the fixture's colour letters, whatever letters Save chose.
function fixtureRows(text: string): string[] {
  const pal = Object.fromEntries(text.split('PALETTE\n')[1]!.trim().split('\n').map((l) => l.split('=') as [string, string]))
  return gridOf(text).map((r) => [...r].map((ch) => (ch === '.' ? '.' : 'abc'[FIXTURE_PALETTE.indexOf(pal[ch]!)])).join(''))
}

describe('tile editor pane', () => {
  test('a blank set opens as grass with a painted blob; Save puts a 4x4 sheet in the prompt', async ($, on) => {
    const filled = host(on)
    for (const surface of SURFACES) {
      filled.length = 0
      const r = await run($, '8')
      expect(r.text).toContain('Opened "grass" (16 tiles of 8x8, 4 colours) in the tile editor')
      const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: PANE, props: pane(80, 40), viewport: { columns: 80, rows: 40 } })
      await ui.resize({ columns: 78, rows: 30, in: 'tiles' })
      expect(await ui.find({ in: 'tiles', type: 'Text', text: /^paint map · 8px tiles · 4x3 cells/ })).toBeDefined()
      await ui.press({ key: 'save' })
      expect(filled[0]!.mode).toBe('replace')
      const text = filled[0]!.text
      expect(text.startsWith('Here is the Wang tileset "grass" from the tile editor: 16 tiles of 8x8, 4 colours, as a 4x4 sheet (32x32). Tile i')).toBe(true)
      const rows = gridOf(text)
      expect(rows).toHaveLength(32)
      expect(rows.slice(0, 8).every((row) => row.slice(0, 8) === '........')).toBe(true) // tile 0: no corners painted
      expect(rows.slice(24).every((row) => !row.slice(24).includes('.'))).toBe(true) // tile 15: the base
      expect(await ui.find({ in: 'tiles', type: 'Text', text: /Enter to send/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('Claude drafts a base texture and the 16 tiles derive from it', async ($, on) => {
    const filled = host(on)
    const palette = ['#223344', '#ccbb99']
    const base = Array.from({ length: 6 }, (_, y) => Array.from({ length: 6 }, (_, x) => ((x * y) % 3 === 0 ? 0 : 1)))
    const r = await $.tool.call({ tool: TOOL, palette, base, name: 'stone' })
    expect(String(r.result)).toContain('Opened "stone" (16 tiles of 6x6, 2 colours)')
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PANE, props: pane(80, 40), viewport: { columns: 80, rows: 40 } })
    await ui.resize({ columns: 78, rows: 30, in: 'tiles' })
    await ui.press({ key: 'save' })
    expect(filled[0]!.text).toBe(tilesText({ name: 'stone', path: null, source: 'draft' }, 6, palette, deriveTiles(base.flat(), 6)))
  })

  test('paint map cells; Edit pixels lands each stroke in the tile under it; undo and redo', async ($, on) => {
    const filled = host(on)
    const palette = ['#111111', '#eeeeee'], base = new Array(16).fill(0)
    await $.tool.call({ tool: TOOL, palette, base: [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], name: 'flat' })
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PANE, props: pane(80, 40), viewport: { columns: 80, rows: 40 } })
    await ui.resize({ columns: 78, rows: 30, in: 'tiles' })
    // 4px tiles in 78 columns: a 4x3 map at zoom 2, a map pixel 4 columns x 2 rows, a cell 16 x 8.
    expect(await ui.find({ in: 'tiles', type: 'Text', text: /4px tiles · 4x3 cells/ })).toBeDefined()
    const cell = (x: number, y: number) => ({ x: x * 16 + 1, y: y * 8 + 1, in: 'tiles' })
    // Edit pixels zooms to 3 (a map pixel 6 columns x 3 rows) on 3x2 cells, centred on the
    // painted ones: cells 0-2 across, 1-2 down, so drawn pixel (x, y) is map pixel (x, y + 4).
    const px = (x: number, y: number) => ({ x: x * 6 + 1, y: (y - 4) * 3 + 1, in: 'tiles' })
    const click = async (at: { x: number; y: number; in: string }, button: 'left' | 'right' = 'left') => {
      await ui.pointer({ type: 'down', ...at, button })
      await ui.pointer({ type: 'up', ...at, button })
    }
    await ui.press({ key: 'clear' })
    await ui.pointer({ type: 'down', ...cell(1, 1), button: 'left' })
    await ui.pointer({ type: 'move', ...cell(2, 1), button: 'left' })
    await ui.pointer({ type: 'up', ...cell(2, 1), button: 'left' })
    await click(cell(1, 2))
    await click(cell(3, 2))
    await click(cell(3, 2), 'right') // cleared again
    await ui.press({ key: 'm-pixels' })
    expect(await ui.find({ in: 'tiles', type: 'Text', text: /4px tiles · 3x2 cells/ })).toBeDefined()
    await ui.press({ key: 'c1' })
    await click(px(6, 6)) // the corner where cells (1,1), (2,1) and (1,2) meet: tile 7, its pixel (0,0)
    await click(px(5, 5)) // the corner whose only painted cell is (1,1), to its SE: tile 8, pixel (3,3)
    await ui.press({ key: 'save' })
    const tiles = deriveTiles(base, 4)
    tiles[7]![0] = 1
    tiles[8]![15] = 1
    const text = (t: number[][]) => tilesText({ name: 'flat', path: null, source: 'draft' }, 4, palette, t)
    expect(filled[0]!.text).toBe(text(tiles))
    await ui.key({ key: 'z', ctrl: true, in: 'tiles' })
    await ui.press({ key: 'save' })
    const undone = tiles.map((t) => t.slice())
    undone[8] = deriveTiles(base, 4)[8]!
    expect(filled[1]!.text).toBe(text(undone))
    await ui.key({ key: 'z', ctrl: true, shift: true, in: 'tiles' })
    await ui.press({ key: 'save' })
    expect(filled[2]!.text).toBe(text(tiles))
    await click(px(7, 7), 'right') // picks tile 7's colour there
    expect(await ui.find({ in: 'tiles', type: 'Text', text: /^edit pixels #111111 · / })).toBeDefined()
  })

  test('Edit pixels on big tiles shows the painted cells, not the corner of the map', async ($, on) => {
    const filled = host(on)
    const palette = ['#111111', '#eeeeee'], base = new Array(32 * 32).fill(0)
    await $.tool.call({ tool: TOOL, palette, base: Array.from({ length: 32 }, () => new Array(32).fill(0)), name: 'big' })
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PANE, props: pane(80, 40), viewport: { columns: 80, rows: 40 } })
    await ui.resize({ columns: 80, rows: 30, in: 'tiles' })
    // Painting cells shows a 5x3 map at half size, a plus of cells painted in its middle: (2,0),
    // (1,1), (2,1), (3,1), (2,2). Drawing pixels needs full size, which fits 2x1 cells: the
    // middle ones, (1,1) and (2,1).
    expect(await ui.find({ in: 'tiles', type: 'Text', text: /32px tiles · 5x3 cells at 1\/2 size/ })).toBeDefined()
    await ui.press({ key: 'm-pixels' })
    expect(await ui.find({ in: 'tiles', type: 'Text', text: /32px tiles · 2x1 cells/ })).toBeDefined()
    await ui.press({ key: 'c1' })
    const click = async (x: number) => {
      await ui.pointer({ type: 'down', x, y: 0, button: 'left', in: 'tiles' })
      await ui.pointer({ type: 'up', x, y: 0, button: 'left', in: 'tiles' })
    }
    // Drawn pixel (0, 0) is map pixel (32, 32), the corner whose only painted cell is (1,1) to its
    // SE: tile 8, at its pixel (16, 16). Drawn pixel (32, 0) is the corner of (2,0), (1,1) and
    // (2,1): tile 14 (NE+SW+SE).
    await click(0)
    await click(32)
    await ui.press({ key: 'save' })
    const tiles = deriveTiles(base, 32)
    tiles[8]![16 * 32 + 16] = 1
    tiles[14]![16 * 32 + 16] = 1
    expect(filled[0]!.text).toBe(tilesText({ name: 'big', path: null, source: 'draft' }, 32, palette, tiles))
  })

  test('edit a tile and the base texture: Done re-derives the edge tiles and keeps the hand-drawn one', async ($, on) => {
    const filled = host(on)
    const palette = ['#111111', '#eeeeee'], old = new Array(16).fill(0)
    await $.tool.call({ tool: TOOL, palette, base: [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], name: 'flat' })
    for (const surface of SURFACES) {
      filled.length = 0
      const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: PANE, props: pane(80, 40), viewport: { columns: 80, rows: 40 } })
      await ui.resize({ columns: 78, rows: 30, in: 'tiles' })
      // A 4x4 tile at zoom 4: a pixel is 8 columns x 4 rows.
      const px = (x: number, y: number) => ({ x: x * 8 + 1, y: y * 4 + 1, in: 'tiles' })
      const click = async (at: { x: number; y: number; in: string }) => {
        await ui.pointer({ type: 'down', ...at, button: 'left' })
        await ui.pointer({ type: 'up', ...at, button: 'left' })
      }
      await ui.press({ key: 'tile-8' })
      expect(await ui.find({ in: 'tiles', type: 'Text', text: /^Tile 8: drawn where SE is painted/ })).toBeDefined()
      await ui.press({ key: 'c1' })
      await click(px(0, 0))
      await ui.press({ key: 't-fill' })
      await click(px(0, 1))
      await ui.key({ key: 'z', ctrl: true, in: 'tiles' }) // the fill goes
      await ui.key({ key: 'z', ctrl: true, shift: true, in: 'tiles' }) // and comes back
      await ui.press({ key: 'done' })
      const drawn = deriveTiles(old, 4)[8]!.slice()
      drawn[0] = 1
      flood(drawn, 4, 4, 4, 1)
      // The base, with its seams brought to the middle: its pixel (0,0) is then the texture's (2,2).
      await ui.press({ key: 'base' })
      expect(await ui.find({ in: 'tiles', type: 'Text', text: /^Base texture: Done derives/ })).toBeDefined()
      await ui.press({ key: 'offset' })
      await ui.press({ key: 't-brush' })
      await click(px(0, 0))
      await ui.press({ key: 'done' })
      expect(await ui.find({ in: 'tiles', type: 'Text', text: /kept 1 hand-drawn tile as it was/ })).toBeDefined()
      await ui.press({ key: 'save' })
      const fresh = old.slice()
      fresh[10] = 1
      const want = deriveTiles(fresh, 4)
      want[8] = drawn
      const text = (t: number[][]) => tilesText({ name: 'flat', path: null, source: 'draft' }, 4, palette, t)
      expect(filled[0]!.text).toBe(text(want))
      // Previous version brings back tile 8 as it was before its Done.
      await ui.press({ key: 'tile-8' })
      await ui.press({ key: 'previous' })
      await ui.press({ key: 'done' })
      await ui.press({ key: 'save' })
      want[8] = deriveTiles(old, 4)[8]!
      expect(filled[1]!.text).toBe(text(want))
      await ui.unmount()
    }
  })

  test("PNGs: SpriteForge's 4x4 sheet and 16x1 strip save back as they were; a texture makes the engine's set", async ($, on) => {
    const filled = host(on)
    const open = async (args: string) => {
      filled.length = 0
      const r = await run($, args)
      const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PANE, props: pane(80, 40), viewport: { columns: 80, rows: 40 } })
      await ui.resize({ columns: 78, rows: 30, in: 'tiles' })
      await ui.press({ key: 'save' })
      await ui.unmount()
      return { said: r.text || '', text: filled[0]!.text }
    }
    const sheet = await open('art/sheet.png')
    expect(sheet.said).toContain('Opened "sheet" (16 tiles of 8x8, 3 colours)')
    expect(sheet.text).toContain('as a 4x4 sheet (32x32)')
    expect(sheet.text).toContain('Write it back to art/sheet.png:')
    expect(fixtureRows(sheet.text)).toEqual(SHEET_ROWS)
    const strip = await open('art/strip.png')
    expect(strip.text).toContain('as a 16x1 strip (128x8)')
    expect(strip.text).toContain('Write it back to art/strip.png:')
    expect(fixtureRows(strip.text)).toEqual(STRIP_ROWS)
    const tex = await open('art/tex.png')
    expect(tex.said).toContain('Opened "tex" (16 tiles of 8x8')
    expect(tex.text).toContain('It was made from the texture art/tex.png, which stays as it is')
    expect(fixtureRows(tex.text)).toEqual(SHEET_ROWS)
    expect((await run($, 'art/odd.png')).text).toContain('is 10x6: a Wang set is a 4x4 sheet or a 16x1 strip')
  })

  test('a detailed set stays inside the drawing limit in both map modes and a tile', async ($, on) => {
    host(on)
    let seed = 5
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    const palette = Array.from({ length: 16 }, (_, i) => '#' + ((i * 7919 * 2654435761) % 16777216).toString(16).padStart(6, '0'))
    for (const size of [16, 32]) {
      const base = Array.from({ length: size }, () => Array.from({ length: size }, () => Math.floor(rnd() * 16)))
      await $.tool.call({ tool: TOOL, palette, base, name: 'noise' })
      for (const [surface, cols] of [['terminal', 78], ['desktop', 140]] as const) {
        const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: PANE, props: pane(cols + 2, 50), viewport: { columns: cols + 2, rows: 50 } })
        await ui.resize({ columns: cols, rows: 50, in: 'tiles' })
        // Each view with and without the grid (the desktop's hairlines take a share of the budget).
        const fits = async () => {
          for (let i = 0; i < 2; i++) {
            expect(JSON.stringify(await ui.drawn({ in: 'tiles' })).length).toBeLessThan(100_000)
            await ui.press({ key: 'grid' })
          }
        }
        await fits()
        await ui.press({ key: 'm-pixels' })
        await fits()
        await ui.press({ key: 'base' })
        await fits()
        await ui.unmount()
      }
    }
    // A detailed platformer sheet, wider than a desktop pane while drawing on it: the canvas, its
    // grid and the overview under it.
    const tiles = Array.from({ length: 49 }, () => Array.from({ length: 16 }, () => Array.from({ length: 16 }, () => Math.floor(rnd() * 16))))
    await $.tool.call({ tool: TOOL, kind: 'platformer', palette, tiles, name: 'noisy' } as never)
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'Pane', requestId: PANE, props: pane(80, 50), viewport: { columns: 80, rows: 50 } })
    await ui.resize({ columns: 78, rows: 50, in: 'tiles' })
    await ui.press({ key: 'm-pixels' })
    expect(await ui.find({ in: 'tiles', key: 'overview' })).toBeDefined()
    for (let i = 0; i < 2; i++) {
      expect(JSON.stringify(await ui.drawn({ in: 'tiles' })).length).toBeLessThan(100_000)
      await ui.press({ key: 'grid' })
    }
    await ui.unmount()
  })

  test('a Wang set previewed as walls and isometric: cells still paint, pixel mode stays on the flat map', async ($, on) => {
    host(on)
    const r = await run($, '8 wall')
    expect(r.text).toContain('Opened "grass" (Wang walls: 16 tiles of 8x8, 4 colours)')
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PANE, props: pane(80, 40), viewport: { columns: 80, rows: 40 } })
    await ui.resize({ columns: 78, rows: 30, in: 'tiles' })
    // The colours the map shows (the canvas Box's runs, not the palette's swatches).
    const colours = async () => {
      const out = new Set<string>()
      const walk = (n: unknown) => {
        if (!n || typeof n !== 'object') return
        const el = n as { props?: { color?: string }; children?: unknown[] }
        if (el.props && el.props.color) out.add(el.props.color)
        for (const c of el.children || []) walk(c)
      }
      walk(await ui.find({ in: 'tiles', key: 'canvas' }))
      return out
    }
    expect((await ui.find({ in: 'tiles', key: 'view' }))!.props.label).toBe('View: walls')
    expect(await ui.find({ in: 'tiles', key: 'm-pixels' })).toBeUndefined()
    // The walls' front faces show the base's colours in shade.
    expect((await colours()).has(shadeHex('#3f8a45'))).toBe(true)
    await ui.press({ key: 'view' })
    expect((await ui.find({ in: 'tiles', key: 'view' }))!.props.label).toBe('View: isometric')
    expect(JSON.stringify(await ui.drawn({ in: 'tiles' })).length).toBeLessThan(100_000)
    await ui.press({ key: 'clear' })
    expect((await colours()).has('#3f8a45')).toBe(false)
    // 4x3 cells of 8px project to a 56x28 diamond, in half blocks: a click at (20, 6) is iso
    // pixel (20, 12), flat pixel (10, 14) back through the projection: cell (1, 1).
    await ui.pointer({ type: 'down', x: 20, y: 6, button: 'left', in: 'tiles' })
    await ui.pointer({ type: 'up', x: 20, y: 6, button: 'left', in: 'tiles' })
    expect((await colours()).has('#3f8a45')).toBe(true)
    await ui.press({ key: 'view' })
    expect((await ui.find({ in: 'tiles', key: 'view' }))!.props.label).toBe('View: flat')
    expect(await ui.find({ in: 'tiles', key: 'm-pixels' })).toBeDefined()
  })

  test('a platformer set: 49 tiles on a 7x7 sheet, picked and drawn tile by tile or on the sheet', async ($, on) => {
    const filled = host(on)
    const r = await run($, '8 platformer')
    expect(r.text).toContain('Opened "ground" (a platformer set: 49 tiles of 8x8, 16 colours) in the tile editor. Click a tile to edit it')
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PANE, props: pane(80, 40), viewport: { columns: 80, rows: 40 } })
    await ui.resize({ columns: 78, rows: 30, in: 'tiles' })
    expect(await ui.find({ in: 'tiles', key: 'view' })).toBeUndefined()
    expect(await ui.find({ in: 'tiles', type: 'Text', text: /^pick tiles · 49 tiles of 8px/ })).toBeDefined()
    expect(await ui.find({ in: 'tiles', type: 'Text', text: /^Pick tiles \(M\): click a tile to edit it/ })).toBeDefined()
    // The 56x56 sheet in half blocks: a column a pixel, a row two. Tile 9 is row 2, column 3.
    await ui.pointer({ type: 'down', x: 19, y: 5, button: 'left', in: 'tiles' })
    await ui.pointer({ type: 'up', x: 19, y: 5, button: 'left', in: 'tiles' })
    expect(await ui.find({ in: 'tiles', type: 'Text', text: /^Tile 9 \(row 2, column 3\)/ })).toBeDefined()
    // The tile at zoom 3 (6 columns x 3 rows a pixel): a dot at (2, 3).
    await ui.pointer({ type: 'down', x: 13, y: 10, button: 'left', in: 'tiles' })
    await ui.pointer({ type: 'up', x: 13, y: 10, button: 'left', in: 'tiles' })
    await ui.press({ key: 'done' })
    await ui.press({ key: 'm-pixels' })
    await ui.pointer({ type: 'down', x: 1, y: 1, button: 'left', in: 'tiles' }) // sheet pixel (1, 2): tile 0
    await ui.pointer({ type: 'up', x: 1, y: 1, button: 'left', in: 'tiles' })
    await ui.press({ key: 'save' })
    const text = filled[0]!.text
    expect(text.startsWith('Here is the platformer tileset "ground" from the tile editor: 49 tiles of 8x8, 1 colour, as a 7x7 sheet (56x56)')).toBe(true)
    const rows = gridOf(text)
    expect(rows).toHaveLength(56)
    expect(rows[2]).toBe('.A' + '.'.repeat(54))
    expect(rows[11]).toBe('.'.repeat(18) + 'A' + '.'.repeat(37))
    expect(rows.filter((row) => row.includes('A'))).toHaveLength(2)
    const bad = await $.tool.call({ tool: TOOL, kind: 'platformer', palette: ['#000000'], tiles: Array.from({ length: 16 }, () => [[0]]) } as never)
    expect(String(bad.result)).toContain("tiles must be 49 grids, in SpriteForge's platformer order")
  })

  test('a tile goes to the pixel editor and comes back; a set with no colours gets one to draw with', async ($, on) => {
    const filled = host(on)
    await run($, '8')
    const tiles = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PANE, props: pane(80, 40), viewport: { columns: 80, rows: 40 } })
    await tiles.resize({ columns: 78, rows: 30, in: 'tiles' })
    await tiles.press({ key: 'tile-3' })
    await tiles.press({ key: 'studio' })
    expect(await tiles.find({ in: 'tiles', type: 'Text', text: /Tile 3 is in the pixel editor/ })).toBeDefined()
    const draw = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'spriteforge-draw', props: pane(80, 40), viewport: { columns: 80, rows: 40 } })
    await draw.resize({ columns: 78, rows: 30, in: 'editor' })
    expect(await draw.find({ type: 'Text', text: /grass tile 3/ })).toBeDefined()
    await draw.input({ key: 'hex', text: '#ff0000' })
    // 8x8 at zoom 3: a pixel is 6 columns x 3 rows.
    await draw.pointer({ type: 'down', x: 1, y: 1, button: 'left', in: 'editor' })
    await draw.pointer({ type: 'up', x: 1, y: 1, button: 'left', in: 'editor' })
    await draw.press({ key: 'back' })
    expect(await tiles.find({ in: 'tiles', type: 'Text', text: /Tile 3 is back from the pixel editor: Done keeps it/ })).toBeDefined()
    await tiles.press({ key: 'done' })
    await tiles.press({ key: 'save' })
    const text = filled[0]!.text, pal = Object.fromEntries(text.split('PALETTE\n')[1]!.trim().split('\n').map((l) => l.split('=').reverse() as [string, string]))
    expect(gridOf(text)[0]![24]).toBe(pal['#ff0000'])
    // Tile 15 picked from the tiles is that tile alone: Done derives nothing.
    await tiles.press({ key: 'tile-15' })
    expect(await tiles.find({ in: 'tiles', type: 'Text', text: /^Tile 15: drawn where NW\+NE\+SW\+SE are painted/ })).toBeDefined()
    await tiles.pointer({ type: 'down', x: 1, y: 1, button: 'right', in: 'tiles' })
    await tiles.pointer({ type: 'up', x: 1, y: 1, button: 'right', in: 'tiles' })
    await tiles.press({ key: 'done' })
    await tiles.press({ key: 'save' })
    const before = gridOf(filled[0]!.text), after = gridOf(filled[1]!.text)
    expect(after.filter((row, y) => row !== before[y])).toHaveLength(1)
    // No colours at all: one is seeded, so the brush draws.
    await $.tool.call({ tool: TOOL, palette: [], tiles: Array.from({ length: 16 }, () => [[-1, -1, -1, -1], [-1, -1, -1, -1], [-1, -1, -1, -1], [-1, -1, -1, -1]]), name: 'none' })
    await tiles.press({ key: 'tile-5' })
    await tiles.pointer({ type: 'down', x: 1, y: 1, button: 'left', in: 'tiles' })
    await tiles.pointer({ type: 'up', x: 1, y: 1, button: 'left', in: 'tiles' })
    await tiles.press({ key: 'done' })
    await tiles.press({ key: 'save' })
    expect(filled[2]!.text).toContain('PALETTE\nA=#c6ccd2\n')
  })

  test('on the desktop the platformer sheet keeps whole-cell pixels and scrolls across, so every row takes a click', async ($, on) => {
    const filled = host(on)
    await run($, '8 platformer')
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'Pane', requestId: PANE, props: pane(80, 40), viewport: { columns: 80, rows: 40 } })
    await ui.resize({ columns: 78, rows: 30, in: 'tiles' })
    const status = (re: RegExp) => ui.find({ in: 'tiles', type: 'Text', text: re })
    // The desktop reports whole cells, so the 56x56 sheet is never half blocks (two pixel rows a
    // cell, the lower out of reach): picking tiles, every 2nd pixel as a block, 2 columns x 1 row.
    expect(await status(/^pick tiles · 49 tiles of 8px at 1\/2 size/)).toBeDefined()
    await ui.pointer({ type: 'down', x: 19, y: 5, button: 'left', in: 'tiles' }) // sheet pixel (18, 10): tile 9
    await ui.pointer({ type: 'up', x: 19, y: 5, button: 'left', in: 'tiles' })
    expect(await status(/^Tile 9 \(row 2, column 3\)/)).toBeDefined()
    await ui.press({ key: 'cancel' })
    // Drawing on the sheet takes every pixel: 39 of the 56 across, the rest a scroll away.
    await ui.press({ key: 'm-pixels' })
    expect(await status(/^edit pixels .* · columns 1-39 of 56 \(click the overview, Shift\+Left\/Right\)/)).toBeDefined()
    expect(await ui.find({ in: 'tiles', key: 'left' })).toBeDefined()
    await ui.press({ key: 'right' }) // half a pane across, held at the end: columns 18-56
    expect(await status(/columns 18-56 of 56/)).toBeDefined()
    const click = async (x: number, y: number) => {
      await ui.pointer({ type: 'down', x, y, button: 'left', in: 'tiles' })
      await ui.pointer({ type: 'up', x, y, button: 'left', in: 'tiles' })
    }
    await click(1, 3) // sheet pixel (17, 3), in tile 2
    await ui.key({ key: 'left', shift: true, in: 'tiles' })
    expect(await status(/columns 1-39 of 56/)).toBeDefined()
    await click(1, 1) // pixel (0, 1): row 1, which a half block would have put out of reach
    await click(3, 2) // pixel (1, 2)
    await ui.press({ key: 'zoom-out' }) // no half blocks to zoom out to
    expect(await status(/columns 1-39 of 56/)).toBeDefined()
    await ui.press({ key: 'save' })
    const rows = gridOf(filled[0]!.text)
    expect(rows[3]![17]).toBe('A')
    expect(rows[1]![0]).toBe('A')
    expect(rows[2]![1]).toBe('A')
    expect(rows.join('').replace(/\./g, '')).toHaveLength(3)
    await ui.unmount()
  })

  test('on a narrow desktop pane a big tile scrolls across from its left column', async ($, on) => {
    const filled = host(on)
    const palette = ['#111111', '#eeeeee'], base = new Array(32 * 32).fill(0)
    await $.tool.call({ tool: TOOL, palette, base: Array.from({ length: 32 }, () => new Array(32).fill(0)), name: 'big' })
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'Pane', requestId: PANE, props: pane(40, 40), viewport: { columns: 40, rows: 40 } })
    await ui.resize({ columns: 38, rows: 30, in: 'tiles' })
    const status = (re: RegExp) => ui.find({ in: 'tiles', type: 'Text', text: re })
    await ui.press({ key: 'tile-15' })
    await ui.press({ key: 'c1' })
    // 2 columns a pixel: 19 of the 32 across.
    expect(await status(/^Tile 15: .* · rows 1-29 \(Up\/Down\) · columns 1-19 of 32 \(click the overview, Shift\+Left\/Right\) · Enter is Done/)).toBeDefined()
    await ui.press({ key: 'right' })
    expect(await status(/columns 10-28 of 32/)).toBeDefined()
    await ui.pointer({ type: 'down', x: 1, y: 3, button: 'left', in: 'tiles' }) // pixel (9, 3)
    await ui.pointer({ type: 'up', x: 1, y: 3, button: 'left', in: 'tiles' })
    await ui.key({ key: 'right', shift: true, in: 'tiles' }) // held at the end
    expect(await status(/columns 14-32 of 32/)).toBeDefined()
    await ui.pointer({ type: 'down', x: 37, y: 0, button: 'left', in: 'tiles' }) // pixel (31, 0)
    await ui.pointer({ type: 'up', x: 37, y: 0, button: 'left', in: 'tiles' })
    // Under the 29 canvas rows and a blank one, the whole tile small, a column a pixel: a press there
    // centres the view on that column and paints nothing.
    expect(await ui.find({ in: 'tiles', key: 'overview' })).toBeDefined()
    const press = async (x: number) => {
      await ui.pointer({ type: 'down', x, y: 30, button: 'left', in: 'tiles' })
      await ui.pointer({ type: 'up', x, y: 30, button: 'left', in: 'tiles' })
    }
    await press(0)
    expect(await status(/columns 1-19 of 32/)).toBeDefined()
    await press(20)
    expect(await status(/columns 12-30 of 32/)).toBeDefined()
    await ui.press({ key: 'done' })
    await ui.press({ key: 'save' })
    const tiles = deriveTiles(base, 32)
    tiles[15]![3 * 32 + 9] = 1
    tiles[15]![31] = 1
    expect(filled[0]!.text).toBe(tilesText({ name: 'big', path: null, source: 'draft' }, 32, palette, tiles))
    await ui.unmount()
  })

  test("the toolbar: the tile picker's glyphs beside their buttons, Grid as hairlines or a tint, a help line and Keys", async ($, on) => {
    host(on)
    await run($, '8')
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: PANE, props: pane(80, 40), viewport: { columns: 80, rows: 40 } })
      await ui.resize({ columns: 78, rows: 30, in: 'tiles' })
      // The desktop draws a Button's children in its own colour, so each tile's coloured glyph is a
      // Text beside its Button, whose label is the tile's number.
      const chip = (await ui.find({ in: 'tiles', key: 'tile-chip-8' }))!
      const [glyph, button] = chip.children as { type: string; props: Record<string, unknown>; children?: unknown[] }[]
      expect(glyph!.type).toBe('Text')
      expect(glyph!.children).toEqual(['▗'])
      expect(glyph!.props.color).toMatch(/^#[0-9a-f]{6}$/)
      expect(button!.type).toBe('Button')
      expect(button!.props.key).toBe('tile-8')
      expect(button!.props.label).toBe('8')
      expect((button!.children || []).filter((c) => typeof c !== 'string')).toHaveLength(0)
      expect(await ui.find({ in: 'tiles', type: 'Text', text: /^Paint map \(M\): click or drag cells to paint them/ })).toBeDefined()
      // Grid: hairlines over the desktop's pixels (absolute Boxes); a tint and a checker on the terminal.
      const lines = async () => (await ui.findAll({ in: 'tiles', type: 'Box' })).filter((b) => b.props.position === 'absolute').length
      const checker = async () => JSON.stringify(await ui.find({ in: 'tiles', key: 'canvas' })).includes('░')
      expect(await lines()).toBe(0)
      expect(await checker()).toBe(false)
      await ui.press({ key: 'grid' })
      expect((await ui.find({ in: 'tiles', key: 'grid' }))!.props.variant).toBe('primary')
      if (surface === 'desktop') {
        // 4x3 cells of 8px: 25 lines across, and the 33 down drawn as one row of line and spacer Boxes
        // from the corner (an absolute Box's left takes whole cells only).
        expect(await lines()).toBe(1 + 25)
        expect(await checker()).toBe(false)
      } else {
        expect(await lines()).toBe(0)
        expect(await checker()).toBe(true)
      }
      // A tile: its tools in a group, and the line under them says what the chosen one does.
      await ui.press({ key: 'tile-8' })
      expect(await ui.find({ in: 'tiles', key: 'tools-0' })).toBeDefined()
      expect(await ui.find({ in: 'tiles', type: 'Text', text: /^Brush \(B\): paints the chosen colour; right-click erases/ })).toBeDefined()
      await ui.press({ key: 't-fill' })
      expect(await ui.find({ in: 'tiles', type: 'Text', text: /^Fill \(G\): fills the area of one colour/ })).toBeDefined()
      await ui.key({ key: 'i', in: 'tiles' })
      expect(await ui.find({ in: 'tiles', type: 'Text', text: /^Pick \(I\): takes a colour from the tile/ })).toBeDefined()
      // The grid stays on in the tile: 8x8 at 3x, 9 lines across and one row of the 9 down.
      if (surface === 'desktop') expect(await lines()).toBe(1 + 9)
      await ui.press({ key: 'help' })
      expect(await ui.find({ in: 'tiles', type: 'Text', text: /^Tile: B brush · E eraser · G fill · I pick/ })).toBeDefined()
      await ui.press({ key: 'help' })
      expect(await ui.find({ in: 'tiles', key: 'keys' })).toBeUndefined()
      await ui.press({ key: 'cancel' })
      await ui.unmount()
    }
  })

  test('bad input is refused with a reason', async ($, on) => {
    host(on)
    expect((await run($, '100')).text).toContain('4-64 pixels')
    expect((await run($, 'missing.png')).text).toContain("Couldn't read missing.png")
    const few = await $.tool.call({ tool: TOOL, palette: ['#000000'], tiles: [[[0]], [[0]]] })
    expect(String(few.result)).toContain('tiles must be 16 grids')
    const oblong = await $.tool.call({ tool: TOOL, palette: ['#000000'], base: [[0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0]] })
    expect(String(oblong.result)).toContain('base must be square')
    const none = await $.ui.mount({ plugin: PLUGIN, surface: 'vscode', component: 'Pane', requestId: PANE, props: pane(80, 40) })
    expect(await none.find({ type: 'Text', text: /tile editor needs Claude Code in a terminal or the desktop app/ })).toBeDefined()
  })
})
