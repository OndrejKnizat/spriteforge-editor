import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { cellWidth, fit, pixelAt } from '../hooks/pixels'
import { spriteFromPng } from '../hooks/png'
import { WRITERS, spriteText } from '../hooks/register'
import { hexHsv, hsvHex, shiftHex } from '../hooks/tools'

const PLUGIN = 'spriteforge-editor'
const PANE = 'spriteforge-draw'
const TOOL = 'mcp__spriteforge-editor__open_pixel_editor'
const SURFACES = ['terminal', 'desktop'] as const
// A 13x9 RGBA PNG with transparency (the server decoder's test image).
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAA0AAAAJCAYAAADpeqZqAAAAu0lEQVR4nG1RIQ4CMRCcYHGIVtXvH3gEX8DhKngBop/AIQipxfQHJH0Bqk8gOGwHcbfN5mCTJt1pZ2c6RcydrSQCgHeB3gVWEXoXGHMf+yrCVhK9C4R3gZjLuzAOqsgYpMRW0oQraC9ZYiuJMXcCgJJWqnI7PVFF+LgcsN2fcd+sYcu7wNfxit37Ayw9AxMGAKpg+5g70UqiLiVrAJZoQ4F9tPpXxWWiOnBIKtEGorH/9P9s6Deo6rA1k7+m5cNvmnTz1gAAAABJRU5ErkJggg=='
const HERO_GRID = ['AB.CCDCADCDBC', 'C..CBCD.CDCBD', 'CDD.CBCDBA.BD', 'CDADBCDDBACDC', 'DCDB.D.A.D.AA', 'BBBCDAD.A.ADC', 'CD.BAB..CCDDA', 'AAD.D.CCA.CCA', 'D.A.AC.ABDC.C']

const bytesOf = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))

// A slash command as the person types it.
const run = ($: { command: { run: (i: never) => Promise<{ text?: string }> } }, args: string) =>
  $.command.run({ command: 'spriteforge-draw', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as never)

const pane = (cols: number, rows: number) => ({
  title: 'Pixel editor', isFocused: true, bodyColumns: cols, placement: 'inline' as const,
  scroll: { offset: 0, bodyRows: rows }, view: {},
})

// What sits beneath the plugin: the pane opens, the prompt box starts empty and records fills,
// the one file there is art/hero.png, and files written (through the base64 decoder for binary
// ones) land in `files`. `decoder: false` is a machine without one.
function host(on: On, opts: { decoder?: boolean } = {}) {
  const filled: { text: string; mode: string }[] = []
  const files = new Map<string, Uint8Array | string>()
  const runs: string[][] = []
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('prompt.fill', (_$, e) => {
    filled.push({ text: e.text, mode: e.mode })
    return { isFilled: true }
  })
  on('fs.read', (_$, e) => {
    if (String((e as { path?: unknown }).path).endsWith('hero.png')) return { value: { base64: PNG_B64 } }
    throw new Error('ENOENT: no such file')
  })
  // The engine hands file hooks absolute paths (with backslashes on Windows); `files` keeps them as
  // the plugin named them.
  const rel = (p: string) => p.replace(/\\/g, '/').replace(/^.*?\/spriteforge-editor\//, '')
  on('fs.exists', (_$, e) => ({ value: rel(e.path) === 'art/hero.png' || files.has(rel(e.path)) }))
  on('fs.write', (_$, e) => { files.set(rel(e.path), e.text); return { value: undefined } })
  on('fs.stat', (_$, e) => {
    const f = files.get(rel(e.path))
    if (f === undefined) throw new Error('ENOENT')
    return { value: { kind: 'file' as const, size: f.length, mtimeMs: 0, isLink: false } }
  })
  on('process.run', (_$, e) => {
    runs.push(e.argv.slice())
    const ok = opts.decoder !== false && e.argv[0] === WRITERS.sh
    if (ok) files.set(rel(e.init!.env!.SF_OUT!), bytesOf(e.init!.stdin!.trim()))
    return { value: { exitCode: ok ? 0 : 127, stdout: '', stderr: ok ? '' : 'not found', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return Object.assign(filled, { files, runs })
}
const gridOf = (text: string) => text.split('GRID\n')[1]!.split('\n\nPALETTE')[0]!.split('\n')

// Whether the desktop canvas holds a pixel Box like that (it draws pixels as Box backgrounds).
type BoxLook = { width?: number; height?: number; backgroundColor?: string; position?: string }
const boxes = async (ui: { findAll: (q: never) => Promise<readonly { props: unknown }[]> }, ok: (p: BoxLook) => boolean) =>
  (await ui.findAll({ in: 'editor', type: 'Box' } as never)).some((b) => ok(b.props as BoxLook))

// A pane over a sprite drawn at `z` (each pixel 2z columns by z rows) with clicks and drags by pixel.
async function editor($: Engine, surface: 'terminal' | 'desktop', z: number, rows = 40) {
  const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: PANE, props: pane(80, rows), viewport: { columns: 80, rows } })
  await ui.resize({ columns: 78, rows: 30, in: 'editor' })
  // The desktop draws pixels square, a fraction of a cell wider than two columns; aim at the middle.
  const cw = cellWidth(z, surface === 'desktop')
  const at = (x: number, y: number) => ({ x: Math.floor(x * cw + cw / 2), y: y * z + 1, in: 'editor' })
  const click = async (x: number, y: number, mods: { button?: 'left' | 'right'; shift?: true; alt?: true } = {}) => {
    await ui.pointer({ type: 'down', ...at(x, y), button: mods.button || 'left', shift: mods.shift, alt: mods.alt })
    await ui.pointer({ type: 'up', ...at(x, y), button: mods.button || 'left' })
  }
  const drag = async (...pts: [number, number][]) => {
    await ui.pointer({ type: 'down', ...at(...pts[0]!), button: 'left' })
    for (const p of pts.slice(1)) await ui.pointer({ type: 'move', ...at(...p), button: 'left' })
    await ui.pointer({ type: 'up', ...at(...pts[pts.length - 1]!), button: 'left' })
  }
  const status = (re: RegExp) => ui.find({ in: 'editor', type: 'Text', text: re })
  return { ui, at, click, drag, status, ctrl: (key: string) => ui.key({ key, ctrl: true, in: 'editor' }) }
}

describe('pixel editor pane', () => {
  test('a blank canvas: pick colours, draw, drag, fill, undo/redo, save to the prompt', async ($, on) => {
    const filled = host(on)
    for (const surface of SURFACES) {
      filled.length = 0
      const opened = await run($, '4x3')
      expect(opened.text).toContain('Opened sprite (4x3)')
      const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: PANE, props: pane(80, 40), viewport: { columns: 80, rows: 40 } })
      await ui.resize({ columns: 78, rows: 30, in: 'editor' })
      // 4x3 in 78 columns: zoom 4, a pixel 4 rows tall and 8 columns across (square on the desktop:
      // a fraction of a cell more).
      const px = (x: number) => Math.floor(x * cellWidth(4, surface === 'desktop') + 1)
      await ui.press({ key: 'c8' }) // #ff004d
      await ui.pointer({ type: 'down', x: 0, y: 0, button: 'left', in: 'editor' })
      await ui.pointer({ type: 'up', x: 0, y: 0, button: 'left', in: 'editor' })
      await ui.pointer({ type: 'down', x: px(1), y: 4, button: 'left', in: 'editor' })
      await ui.pointer({ type: 'move', x: px(3), y: 5, button: 'left', in: 'editor' })
      await ui.pointer({ type: 'up', x: px(3), y: 5, button: 'left', in: 'editor' })
      await ui.press({ key: 'c11' }) // #00e436
      await ui.press({ key: 't-fill' })
      await ui.pointer({ type: 'down', x: 2, y: 9, button: 'left', in: 'editor' })
      await ui.pointer({ type: 'up', x: 2, y: 9, button: 'left', in: 'editor' })
      await ui.key({ key: 'z', ctrl: true, in: 'editor' })
      await ui.key({ key: 'z', ctrl: true, shift: true, in: 'editor' })
      await ui.press({ key: 'save' })
      expect(filled).toHaveLength(1)
      expect(filled[0]!.mode).toBe('replace')
      expect(filled[0]!.text).toBe(
        'Here is "sprite" from the pixel editor (4x3, 2 colours):\n\nGRID\nA...\nBAAA\nBBBB\n\nPALETTE\nA=#ff004d\nB=#00e436\n')
      expect(await ui.find({ in: 'editor', type: 'Text', text: /Enter to send/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('Claude opens drafted frames; frames, right-click erase, picker and colour entry work', async ($, on) => {
    const filled = host(on)
    for (const surface of SURFACES) {
      filled.length = 0
      const r = await $.tool.call({ tool: TOOL, palette: ['#112233', '#445566'], frames: [{ grid: [[0, 1], [1, 0]] }, { grid: [[1, 1], [0, 0]] }], name: 'blink' })
      expect(String(r.result)).toContain('Opened "blink" (2x2, 2 colours, 2 frames)')
      const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: PANE, props: pane(80, 40), viewport: { columns: 80, rows: 40 } })
      await ui.resize({ columns: 78, rows: 30, in: 'editor' })
      await ui.press({ key: 'tab-frames' })
      expect(await ui.find({ in: 'editor', type: 'Text', text: /frame 1\/2/ })).toBeDefined()
      await ui.key({ key: 'right', in: 'editor' })
      expect(await ui.find({ in: 'editor', type: 'Text', text: /frame 2\/2/ })).toBeDefined()
      // 2x2 at zoom 4: a pixel is 8 columns x 4 rows. Right-click paints the background:
      // transparent, so it erases (0,0) of frame 2.
      await ui.pointer({ type: 'down', x: 1, y: 1, button: 'right', in: 'editor' })
      await ui.pointer({ type: 'up', x: 1, y: 1, button: 'right', in: 'editor' })
      // The picker takes #112233 from (0,1), then the brush paints it on (1,1).
      await ui.press({ key: 't-picker' })
      await ui.pointer({ type: 'down', x: 1, y: 5, button: 'left', in: 'editor' })
      await ui.pointer({ type: 'up', x: 1, y: 5, button: 'left', in: 'editor' })
      await ui.press({ key: 't-brush' })
      await ui.pointer({ type: 'down', x: 9, y: 5, button: 'left', in: 'editor' })
      await ui.pointer({ type: 'up', x: 9, y: 5, button: 'left', in: 'editor' })
      await ui.press({ key: 'tab-colour' })
      await ui.input({ key: 'hex', text: 'zzz' })
      expect(await ui.find({ in: 'editor', type: 'Text', text: /isn't a colour/ })).toBeDefined()
      await ui.press({ key: 'save' })
      expect(filled[0]!.text).toBe(
        'Here is "blink" from the pixel editor (2x2, 2 colours, 2 frames):\n\nFRAME 1\nGRID\nAB\nBA\n\nFRAME 2\nGRID\n.B\nAA\n\nPALETTE\nA=#112233\nB=#445566\n\nEvery frame shows for 125 ms.\n')
      await ui.unmount()
    }
  })

  test('a PNG from the project opens with its transparency, and Save names the file to write back', async ($, on) => {
    const filled = host(on)
    const opened = await run($, 'art/hero.png')
    expect(opened.text).toContain('Opened hero (13x9)')
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PANE, props: pane(80, 40), viewport: { columns: 80, rows: 40 } })
    await ui.resize({ columns: 78, rows: 30, in: 'editor' })
    await ui.press({ key: 'save' })
    expect(filled[0]!.text).toBe(
      'Here is "hero" from the pixel editor (13x9, 4 colours). Write it back to art/hero.png:\n\nGRID\n' + HERO_GRID.join('\n') + '\n' +
      '\nPALETTE\nA=#6ea8fe\nB=#dcb684\nC=#17161d\nD=#c82828\n')
  })

  test('Claude opens a PNG by path, and is told why when nothing can show the pane', async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: false as const, reason: 'no surface' } }))
    on('session.surfaces', () => ({ value: [] }))
    on('fs.read', () => ({ value: { base64: PNG_B64 } }))
    const r = await $.tool.call({ tool: TOOL, path: 'art/hero.png' })
    expect(String(r.result)).toContain('Loaded "hero" (13x9, 4 colours)')
    expect(String(r.result)).toContain('no surface; surfaces attached: none')
  })

  test("on the terminal's main screen Claude offers fullscreen once ever, the pane says how, and it switches once the turn ends", async ($, on) => {
    host(on)
    const store = new Map<string, unknown>()
    on('store.get', (_$, e) => ({ value: store.get(e.key) }))
    on('store.set', (_$, e) => { store.set(e.key, e.value); return { value: undefined } })
    const switched: string[] = []
    on('command.run', { command: 'tui' }, (_$, e) => { switched.push(e.args); return { text: '' } })
    on('turn.complete', () => ({ text: 'Switching.' }))
    const tool = (name: string, input: object = {}) => $.tool.call({ tool: `mcp__spriteforge-editor__${name}`, ...input } as never)
    const grid = { palette: ['#112233'], grid: [[0]], name: 'dot' }
    const hint = (ui: { find: (q: never) => Promise<unknown> }) => ui.find({ type: 'Text', text: /type \/tui fullscreen to draw here/ } as never)
    // The switch runs unawaited after the turn's end; let it land.
    const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
    // Fullscreen: no offer, no hint, and the switch tool has nothing to do.
    let ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PANE, props: pane(80, 40), viewport: { columns: 80, rows: 40, isFullscreen: true } })
    expect(await hint(ui)).toBeUndefined()
    await ui.unmount()
    expect(String((await tool('open_pixel_editor', grid)).result)).not.toContain('main screen')
    expect(String((await tool('enter_fullscreen')).result)).toContain('nothing to switch')
    // Main screen: the pane says how to switch; the first result asks Claude to offer it, last in its reply.
    ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PANE, props: pane(80, 40), viewport: { columns: 80, rows: 40, isFullscreen: false } })
    expect(await hint(ui)).toBeDefined()
    await ui.unmount()
    const first = String((await tool('open_pixel_editor', grid)).result)
    expect(first).toContain('Only if they say yes, call enter_fullscreen')
    expect(first).toContain('Put that question last in your reply')
    expect(store.get('fullscreenAsked')).toBe(true)
    // Asked once: later results, the tile editor's too, say not to offer it again.
    const again = String((await tool('open_pixel_editor', grid)).result)
    expect(again).toContain("don't offer it again")
    expect(again).not.toContain('Ask the user')
    expect(String((await tool('open_tile_editor', { size: 8 })).result)).toContain("don't offer it again")
    expect((await run($, '8x8')).text).toContain('type /tui fullscreen')
    expect(String((await tool('enter_fullscreen')).result)).toContain('as soon as this turn ends')
    expect(switched).toEqual([])
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)
    await settle()
    expect(switched).toEqual(['fullscreen'])
    // Once only.
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' } as never)
    await settle()
    expect(switched).toEqual(['fullscreen'])
  })

  test('big sprites draw in half blocks; a click lands on its pixel', async ($, on) => {
    const filled = host(on)
    await run($, '64x64')
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PANE, props: pane(70, 40), viewport: { columns: 70, rows: 40 } })
    await ui.resize({ columns: 70, rows: 40, in: 'editor' })
    expect(await ui.find({ in: 'editor', type: 'Text', text: /half blocks/ })).toBeDefined()
    // Without a sub-cell position a half-block cell's click takes its top pixel: (9, 3*2).
    await ui.pointer({ type: 'down', x: 9, y: 3, button: 'left', in: 'editor' })
    await ui.pointer({ type: 'up', x: 9, y: 3, button: 'left', in: 'editor' })
    await ui.press({ key: 'save' })
    const rows = gridOf(filled[0]!.text)
    expect(rows).toHaveLength(64)
    expect(rows[6]![9]).toBe('A')
    expect(rows[7]![9]).toBe('.')
  })

  test('pointer cells map to pixels in both drawing modes, sub-cell position and scrolling included', () => {
    const big = { w: 64, h: 64, zoom: 0 }
    const f = fit(big, 70, 31)
    expect(f).toEqual({ half: true, z: 1, bandRows: 1, total: 32, visible: 31, span: 64, cw: 1 })
    const half = { ...f, top: 0, bands: 31, rows: 31 }
    expect(pixelAt({ type: 'down', x: 5, y: 3, fine: { x: 5.2, y: 3.7 } }, half, big, false)).toEqual([5, 7])
    expect(pixelAt({ type: 'down', x: 5, y: 3, fine: { x: 5.2, y: 3.2 } }, half, big, false)).toEqual([5, 6])
    expect(pixelAt({ type: 'down', x: 5, y: 3 }, half, big, false)).toEqual([5, 6])
    expect(pixelAt({ type: 'down', x: 5, y: 3 }, { ...half, top: 10 }, big, false)).toEqual([5, 26])
    expect(pixelAt({ type: 'down', x: 5, y: 31 }, half, big, false)).toBeNull()
    const small = { w: 16, h: 16, zoom: 0 }
    const fb = fit(small, 80, 40)
    expect(fb).toEqual({ half: false, z: 2, bandRows: 2, total: 16, visible: 16, span: 16, cw: 4 })
    const blocks = { ...fb, top: 0, bands: 16, rows: 32 }
    expect(pixelAt({ type: 'down', x: 7, y: 5 }, blocks, small, false)).toEqual([1, 2])
    expect(pixelAt({ type: 'down', x: 70, y: 5 }, blocks, small, false)).toBeNull()
    expect(pixelAt({ type: 'move', x: 70, y: -3 }, blocks, small, true)).toEqual([15, 0])
    expect(fit({ w: 32, h: 32, zoom: 0 }, 80, 12)).toEqual({ half: false, z: 1, bandRows: 1, total: 32, visible: 12, span: 32, cw: 2 })
    // Sideways (the desktop, which reports whole cells): full-size pixels, scrolled across from `left`.
    // Square (the desktop's tall cells): a pixel is z rows by z / 0.414 columns.
    expect(fit(big, 70, 31, true, true)).toMatchObject({ half: false, z: 1, cw: 2.415, span: 28 })
    expect(pixelAt({ type: 'down', x: 4, y: 0 }, { ...fit(big, 70, 31, true, true), top: 0, bands: 31, rows: 31 }, big, false)).toEqual([1, 0])
    const side = fit(big, 70, 31, true)
    expect(side).toEqual({ half: false, z: 1, bandRows: 1, total: 64, visible: 31, span: 35, cw: 2 })
    expect(pixelAt({ type: 'down', x: 5, y: 3 }, { ...side, top: 0, bands: 31, rows: 31, left: 20 }, big, false)).toEqual([22, 3])
    expect(fit({ ...big, zoom: 0.5 }, 70, 31, true).half).toBe(false)
  })

  test('a detailed sprite stays inside the drawing limit and scrolls', async ($, on) => {
    const filled = host(on)
    let seed = 7
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    const palette = Array.from({ length: 32 }, (_, i) => '#' + ((i * 7919 * 2654435761) % 16777216).toString(16).padStart(6, '0'))
    const grid = Array.from({ length: 64 }, () => Array.from({ length: 64 }, () => Math.floor(rnd() * 32)))
    await $.tool.call({ tool: TOOL, palette, grid, name: 'noise' })
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PANE, props: pane(80, 40), viewport: { columns: 80, rows: 40 } })
    await ui.resize({ columns: 78, rows: 40, in: 'editor' })
    expect(JSON.stringify(await ui.drawn({ in: 'editor' })).length).toBeLessThan(100_000)
    expect(await ui.find({ in: 'editor', type: 'Text', text: /rows 1-\d+ \(Up\/Down\)/ })).toBeDefined()
    await ui.key({ key: 'down', in: 'editor' })
    expect(await ui.find({ in: 'editor', type: 'Text', text: /rows 3-/ })).toBeDefined()
    // The first drawn row is now pixel rows 2-3: a click there paints row 2.
    await ui.press({ key: 't-eraser' })
    await ui.pointer({ type: 'down', x: 4, y: 0, button: 'left', in: 'editor' })
    await ui.pointer({ type: 'up', x: 4, y: 0, button: 'left', in: 'editor' })
    await ui.press({ key: 'save' })
    const rows = gridOf(filled[0]!.text)
    expect(rows[2]![4]).toBe('.')
    expect(rows[0]!.includes('.')).toBe(false)
  })

  test('every tab over a detailed sprite, onion skin and selection still fits the drawing limit', async ($, on) => {
    host(on)
    let seed = 11
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    const palette = Array.from({ length: 64 }, (_, i) => '#' + ((i * 7919 * 2654435761) % 16777216).toString(16).padStart(6, '0'))
    const grid = Array.from({ length: 64 }, () => Array.from({ length: 64 }, () => Math.floor(rnd() * 64)))
    await $.tool.call({ tool: TOOL, palette, grid, name: 'noise' })
    for (const [surface, cols] of [['terminal', 78], ['desktop', 140]] as const) {
      const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: PANE, props: pane(cols + 2, 60), viewport: { columns: cols + 2, rows: 60 } })
      await ui.resize({ columns: cols, rows: 60, in: 'editor' })
      await ui.press({ key: 'tab-frames' })
      await ui.press({ key: 'frame-add' }) // a blank frame over the noise's ghost
      await ui.press({ key: 'onion' })
      await ui.press({ key: 'onion-fwd' })
      await ui.press({ key: 'tab-layers' })
      await ui.press({ key: 'layer-add' })
      await ui.press({ key: 'op-dn' })
      await ui.key({ key: 'a', ctrl: true, in: 'editor' })
      await ui.key({ key: '=', in: 'editor' })
      expect(await ui.find({ in: 'editor', type: 'Text', text: /sel 64x64 at 0,0/ })).toBeDefined()
      for (const tab of ['colour', 'canvas', 'layers', 'frames', 'export']) {
        await ui.press({ key: `tab-${tab}` })
        expect(JSON.stringify(await ui.drawn({ in: 'editor' })).length).toBeLessThan(100_000)
      }
      await ui.press({ key: 'tab-canvas' })
      await ui.press({ key: 'backdrop' })
      expect(JSON.stringify(await ui.drawn({ in: 'editor' })).length).toBeLessThan(100_000)
      await ui.press({ key: 'grid' })
      expect(JSON.stringify(await ui.drawn({ in: 'editor' })).length).toBeLessThan(100_000)
      // The desktop's grid is hairlines over the pixels; the terminal's a tint.
      expect(await boxes(ui, (p) => p.position === 'absolute')).toBe(surface === 'desktop')
      await ui.press({ key: 'tab-colour' }) // the picker shows with the Colour tab
      await ui.press({ key: 'help' })
      expect(JSON.stringify(await ui.drawn({ in: 'editor' })).length).toBeLessThan(100_000)
      await ui.unmount()
    }
  })

  test('bad input is refused with a reason, and nothing else is drawn', async ($, on) => {
    host(on)
    expect((await run($, '100x100')).text).toContain('1-64 pixels')
    expect((await run($, '100x100')).text).toContain('browser editor on spriteforge.tech takes up to 128x128')
    expect((await run($, '20x20')).text).not.toContain('spriteforge.tech')
    expect((await run($, 'missing.png')).text).toContain("Couldn't read missing.png")
    const bad = await $.tool.call({ tool: TOOL, palette: ['#000000'], grid: [[0, 3]] })
    expect(String(bad.result)).toContain('palette indexes 0-0')
    const none = await $.ui.mount({ plugin: PLUGIN, surface: 'vscode', component: 'Pane', requestId: PANE, props: pane(80, 40) })
    expect((await none.find({ type: 'Text', text: /terminal or the desktop app/ }))).toBeDefined()
  })

  test('shapes, brush size and mirror painting', async ($, on) => {
    const filled = host(on)
    await run($, '10x10')
    // 10x10 in 78 columns and 32 rows: zoom 3, a pixel is 6 columns x 3 rows.
    const { ui, at, drag, click } = await editor($, 'desktop', 3, 48)
    await ui.press({ key: 'c8' })
    await ui.press({ key: 't-line' })
    await ui.pointer({ type: 'down', ...at(0, 0), button: 'left' })
    await ui.pointer({ type: 'move', ...at(4, 0), button: 'left' })
    // The line shows while it is dragged: five pixels of 6 columns, 3 rows (on the desktop, one Box).
    expect(await boxes(ui, (p) => Math.abs((p.width || 0) - 5 * cellWidth(3, true)) < 0.01 && p.height === 3 && !!p.backgroundColor)).toBe(true)
    await ui.pointer({ type: 'up', ...at(4, 0), button: 'left' })
    await ui.press({ key: 't-rect' })
    await drag([0, 2], [3, 5])
    await ui.press({ key: 't-ellipse' })
    await ui.press({ key: 'filled' })
    await drag([5, 0], [9, 4])
    await ui.press({ key: 't-brush' })
    await ui.press({ key: 'size-up' }) // 2
    await click(5, 7)
    await ui.press({ key: 'size-dn' })
    await ui.press({ key: 'sym-x' })
    await click(0, 9)
    await ui.press({ key: 'save' })
    expect(filled[0]!.text).toBe('Here is "sprite" from the pixel editor (10x10, 1 colour):\n\nGRID\n' +
      'AAAAA.AAA.\n.....AAAAA\nAAAA.AAAAA\nA..A.AAAAA\nA..A..AAA.\nAAAA......\n..........\n.....AA...\n.....AA...\nA........A\n' +
      '\nPALETTE\nA=#ff004d\n')
  })

  test('painting: background colour, Shift+click lines, Alt+click picks, pixel-perfect, shade, global fill', async ($, on) => {
    const filled = host(on)
    await run($, '8x4')
    const { ui, click, drag } = await editor($, 'terminal', 4)
    await ui.press({ key: 'c8' }) // #ff004d
    await click(0, 0)
    await click(3, 0, { shift: true }) // a line from the last point
    await ui.press({ key: 'target-bg' })
    await ui.press({ key: 'c11' }) // the background: #00e436
    await ui.press({ key: 'target-fg' })
    await click(0, 1, { button: 'right' })
    await click(0, 1, { alt: true }) // picks it as the foreground
    await click(1, 1)
    await ui.press({ key: 'c8' })
    await ui.press({ key: 'perfect' })
    await drag([0, 2], [1, 2], [1, 3], [2, 3]) // the corner at (1,2) goes
    await ui.press({ key: 't-shade' })
    await click(0, 0) // darker
    await click(1, 0, { button: 'right' }) // lighter
    await ui.press({ key: 't-fill' })
    await ui.press({ key: 'global' })
    await ui.press({ key: 'c11' })
    await click(2, 0) // every #ff004d pixel
    await ui.press({ key: 'save' })
    expect(filled[0]!.text).toBe('Here is "sprite" from the pixel editor (8x4, 3 colours):\n\nGRID\n' +
      'BCAA....\nAA......\nA.......\n.AA.....\n' +
      `\nPALETTE\nA=#00e436\nB=${shiftHex('#ff004d', -0.12)}\nC=${shiftHex('#ff004d', 0.12)}\n`)
  })

  test('selection: move, copy and paste, flip, cut, clear, undo', async ($, on) => {
    const filled = host(on)
    const grid = [[0, 1, -1, -1, -1, -1, -1, -1], [1, 0, -1, -1, -1, -1, -1, -1], new Array(8).fill(-1), new Array(8).fill(-1)]
    await $.tool.call({ tool: TOOL, palette: ['#112233', '#445566'], grid, name: 'pair' })
    // 8x4: zoom 4, a pixel is 8 columns x 4 rows.
    const { ui, drag, ctrl, status } = await editor($, 'terminal', 4)
    await ui.press({ key: 't-select' })
    await drag([0, 0], [1, 1])
    expect(await status(/sel 2x2 at 0,0 ·/)).toBeDefined()
    await drag([0, 0], [3, 0]) // lifts the 2x2 and moves it
    expect(await status(/sel 2x2 at 3,0 floating/)).toBeDefined()
    await ctrl('c')
    expect(await status(/Copied 2x2/)).toBeDefined()
    await ui.key({ key: 'return', in: 'editor' }) // sets it down
    await ctrl('v') // pastes where it was copied, floating
    await drag([3, 0], [0, 2])
    await ui.press({ key: 'flip-h' })
    await drag([7, 3]) // a click outside sets it down and selects nothing
    await drag([3, 0], [3, 1])
    await ctrl('x')
    await drag([4, 0], [4, 1])
    await ui.press({ key: 'clear' })
    await ctrl('v') // the cut column, back where it was cut from
    await ui.press({ key: 'save' })
    const text = (rows: string) => `Here is "pair" from the pixel editor (8x4, 2 colours):\n\nGRID\n${rows}\n\nPALETTE\nA=#112233\nB=#445566\n`
    expect(filled[0]!.text).toBe(text('...A....\n...B....\nBA......\nAB......'))
    await ctrl('z') // the paste goes
    await ui.press({ key: 'save' })
    expect(filled[1]!.text).toBe(text('........\n........\nBA......\nAB......'))
  })

  test('selection masks: wand and lasso add and take away, fills stay inside, arrows nudge', async ($, on) => {
    const filled = host(on)
    const e = -1, grid = [[0, 0, 1, 1, e, e, e, e], [0, 0, 1, 1, e, e, e, e], [e, e, e, e, e, e, e, e], [e, e, e, e, e, e, 0, e]]
    await $.tool.call({ tool: TOOL, palette: ['#112233', '#445566'], grid, name: 'bits' })
    const { ui, click, drag, status } = await editor($, 'terminal', 4)
    await ui.press({ key: 't-wand' })
    await click(0, 0)
    expect(await status(/^Wand: selected 4 px of #112233 · sel 2x2 at 0,0\.$/)).toBeDefined()
    await click(2, 0, { shift: true })
    expect(await status(/^Wand: selected 4 px of #445566 · sel 4x2 at 0,0\.$/)).toBeDefined()
    await click(0, 0, { button: 'right' })
    expect(await status(/^Wand: took away 4 px of #112233 · sel 2x2 at 2,0\.$/)).toBeDefined()
    await ui.press({ key: 'clear' })
    await ui.press({ key: 't-lasso' })
    await drag([5, 2], [7, 2], [7, 3], [5, 3])
    expect(await status(/sel 3x2 at 5,2 ·/)).toBeDefined()
    await ui.press({ key: 't-fill' })
    await click(5, 2) // the transparent run, cut to the selection
    await ui.press({ key: 't-lasso' })
    await ui.key({ key: 'left', in: 'editor' })
    await ui.key({ key: 'return', in: 'editor' })
    await ui.press({ key: 'save' })
    expect(gridOf(filled[0]!.text)).toEqual(['AA......', 'AA......', '....AAA.', '....AAA.'])
  })

  test('selection transforms: scale by a corner, turn from outside one, custom brush', async ($, on) => {
    const filled = host(on)
    const e = -1, row = (...v: number[]) => v.concat([e, e, e, e])
    const grid = [row(0, 0, 0, 1), row(0, 1, 1, 0), row(0, 1, 1, 0), row(0, 0, 0, 0), ...Array.from({ length: 4 }, () => new Array(8).fill(e))]
    await $.tool.call({ tool: TOOL, palette: ['#112233', '#445566'], grid, name: 'block' })
    // 8x8 in 78 columns and 24 rows: zoom 3, a pixel is 6 columns x 3 rows.
    const { ui, at, drag, click, ctrl, status } = await editor($, 'terminal', 3)
    await ui.press({ key: 't-select' })
    await drag([0, 0], [3, 3])
    await drag([3, 3], [5, 5]) // the bottom-right corner handle
    expect(await status(/Scaled to 6x6/)).toBeDefined()
    await ui.key({ key: 'return', in: 'editor' })
    await ui.press({ key: 'save' })
    expect(gridOf(filled[0]!.text)).toEqual(['AAAAAB..', 'AAAAAB..', 'AABBBA..', 'AABBBA..', 'AABBBA..', 'AAAAAA..', '........', '........'])
    await ctrl('z') // back to the 4x4, selected
    expect(await status(/sel 4x4 at 0,0 ·/)).toBeDefined()
    // Just outside the bottom-right corner, then round a quarter turn (Shift snaps to 15°).
    await ui.pointer({ type: 'down', ...at(5, 5), button: 'left' })
    await ui.pointer({ type: 'move', x: -9, y: 15, in: 'editor', button: 'left', shift: true })
    await ui.pointer({ type: 'up', x: -9, y: 15, in: 'editor', button: 'left' })
    expect(await status(/Turned 90° around the pivot/)).toBeDefined()
    await ui.key({ key: 'return', in: 'editor' })
    await ui.press({ key: 'save' })
    expect(gridOf(filled[1]!.text)).toEqual(['AAAA....', 'ABBA....', 'ABBA....', 'AAAB....', '........', '........', '........', '........'])
    await ctrl('d')
    await drag([1, 1], [2, 2])
    await ctrl('b')
    expect(await status(/Custom brush 2x2 \(4 px\)/)).toBeDefined()
    await click(6, 6)
    await ui.press({ key: 'brush-clear' })
    await ui.press({ key: 'save' })
    expect(gridOf(filled[2]!.text).slice(4)).toEqual(['........', '.....BB.', '.....BB.', '........'])
  })

  test('palette: remove and sort swatches, reduce with keep and revert, HSV steps, live swatch, DB32', async ($, on) => {
    const filled = host(on)
    await $.tool.call({ tool: TOOL, palette: ['#ff0000', '#00ff00', '#0000ff', '#fe0000'], grid: [[0, 1, 2, 3]], name: 'reds' })
    const { ui, status } = await editor($, 'terminal', 4)
    await ui.press({ key: 'c1' })
    await ui.press({ key: 'pal-remove' })
    expect(await status(/Removed #00ff00 and cleared its pixels/)).toBeDefined()
    await ui.press({ key: 'pal-sort' }) // #0000ff, #fe0000, #ff0000
    for (let i = 0; i < 6; i++) await ui.press({ key: 'reduce-dn' }) // to 2
    await ui.press({ key: 'reduce' })
    expect(await status(/Preview: 2 colours/)).toBeDefined()
    await ui.press({ key: 'reduce-revert' })
    await ui.press({ key: 'save' })
    expect(filled[0]!.text).toContain('GRID\nC.AB\n\nPALETTE\nA=#0000ff\nB=#fe0000\nC=#ff0000\n')
    await ui.press({ key: 'reduce' })
    await ui.press({ key: 'reduce-keep' })
    await ui.press({ key: 'save' })
    expect(filled[1]!.text).toContain('GRID\nB.AB\n\nPALETTE\nA=#0000ff\nB=#ff0000\n')
    // The foreground's hue stepped; then, editing the swatch live, its value - every pixel follows.
    await ui.press({ key: 'c0' })
    await ui.press({ key: 'h-up' })
    const turned = hsvHex(255, 1, 1)
    expect((await ui.find({ in: 'editor', key: 'target-fg' }))!.text).toContain(turned)
    await ui.press({ key: 'live' })
    await ui.press({ key: 'v-dn' })
    const c = hexHsv(turned), darker = hsvHex(c.h, c.s, c.v - 0.1)
    await ui.press({ key: 'save' })
    expect(filled[2]!.text).toContain(`GRID\nB.AB\n\nPALETTE\nA=${darker}\nB=#ff0000\n`)
    await ui.press({ key: 'db32' })
    expect(await status(/DB32: added 32 colours/)).toBeDefined()
    expect(await status(/^2 colours in use · 34 in the palette$/)).toBeDefined()
  })

  test('canvas: size by anchor and around the content, resample, trim, outline and strip, remove BG, offset, tidy, tiled view, crop', async ($, on) => {
    const filled = host(on)
    const e = -1
    await $.tool.call({ tool: TOOL, palette: ['#ff0000'], grid: [[e, e, e, e], [e, 0, 0, e], [e, 0, 0, e], [e, e, e, e]], name: 'dot' })
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PANE, props: pane(80, 40), viewport: { columns: 80, rows: 40 } })
    await ui.resize({ columns: 78, rows: 30, in: 'editor' })
    const status = (re: RegExp) => ui.find({ in: 'editor', type: 'Text', text: re })
    const saved = async () => { await ui.press({ key: 'save' }); return gridOf(filled[filled.length - 1]!.text) }
    await ui.press({ key: 'tab-canvas' })
    await ui.input({ key: 'canvas-size', text: '6x6' })
    expect(await status(/Canvas 4x4 -> 6x6, anchored middle/)).toBeDefined()
    await ui.select({ key: 'anchor', value: '0' })
    await ui.input({ key: 'canvas-size', text: '8x6' })
    expect(await saved()).toEqual(['........', '........', '..AA....', '..AA....', '........', '........'])
    await ui.select({ key: 'anchor', value: 'fit' })
    await ui.input({ key: 'canvas-size', text: '4' })
    expect(await saved()).toEqual(['....', '.AA.', '.AA.', '....'])
    await ui.input({ key: 'resample', text: '8' })
    expect(await status(/Resampled 4x4 -> 8x8/)).toBeDefined()
    await ui.press({ key: 'trim' })
    expect(await saved()).toEqual(['AAAA', 'AAAA', 'AAAA', 'AAAA'])
    await ui.input({ key: 'canvas-size', text: '6' })
    await ui.press({ key: 'outline' })
    expect(await status(/Added a 1px dark-tinted outline \(16 px\)/)).toBeDefined()
    expect(await saved()).toEqual(['.BBBB.', 'BAAAAB', 'BAAAAB', 'BAAAAB', 'BAAAAB', '.BBBB.'])
    await ui.press({ key: 'strip' })
    expect(await status(/Stripped the outline \(16 px\)/)).toBeDefined()
    // A blue background around it, then Remove BG takes it away again.
    await ui.press({ key: 'tab-colour' })
    await ui.input({ key: 'hex', text: '0000ff' })
    await ui.press({ key: 't-fill' })
    await ui.pointer({ type: 'down', x: 1, y: 1, button: 'left', in: 'editor' })
    await ui.pointer({ type: 'up', x: 1, y: 1, button: 'left', in: 'editor' })
    await ui.press({ key: 'tab-canvas' })
    await ui.press({ key: 'rmbg' })
    expect(await status(/Removed the background \(20 px\)/)).toBeDefined()
    await ui.press({ key: 'offset' })
    expect(await saved()).toEqual(['AA..AA', 'AA..AA', '......', '......', 'AA..AA', 'AA..AA'])
    await ui.key({ key: 'z', ctrl: true, in: 'editor' })
    await ui.press({ key: 't-eraser' })
    // 6x6 at zoom 4: a pixel is 8 columns x 4 rows; a pin-hole at (2,2), and Tidy fills it.
    await ui.pointer({ type: 'down', x: 17, y: 9, button: 'left', in: 'editor' })
    await ui.pointer({ type: 'up', x: 17, y: 9, button: 'left', in: 'editor' })
    await ui.press({ key: 'tidy' })
    expect(await status(/Tidy filled 1 pin-hole/)).toBeDefined()
    // Tiled 3x3 (18x18 at zoom 1: 2 columns by 1 row a pixel): a click on a copy lands on the sprite.
    await ui.press({ key: 'tile3' })
    await ui.press({ key: 't-brush' })
    await ui.pointer({ type: 'down', x: 2 * 6 + 1, y: 0, button: 'left', in: 'editor' })
    await ui.pointer({ type: 'up', x: 2 * 6 + 1, y: 0, button: 'left', in: 'editor' })
    await ui.press({ key: 'tile3' })
    expect(await saved()).toEqual(['B.....', '.AAAA.', '.AAAA.', '.AAAA.', '.AAAA.', '......'])
    await ui.press({ key: 't-select' })
    await ui.pointer({ type: 'down', x: 9, y: 5, button: 'left', in: 'editor' })
    await ui.pointer({ type: 'move', x: 33, y: 17, button: 'left', in: 'editor' })
    await ui.pointer({ type: 'up', x: 33, y: 17, button: 'left', in: 'editor' })
    await ui.press({ key: 'crop-cv' })
    expect(await status(/Cropped to the selection: 4x4/)).toBeDefined()
  })

  test('layers: add, draw over, hide, reorder, merge, lock, opacity, rename; Save flattens the visible ones', async ($, on) => {
    const filled = host(on)
    await $.tool.call({ tool: TOOL, palette: ['#ff004d', '#00e436'], frames: [{ grid: [[0, -1], [-1, -1]] }, { grid: [[-1, 0], [-1, -1]] }], name: 'stack' })
    const { ui, click, status } = await editor($, 'desktop', 4)
    const chip = async (i: number) => (await ui.find({ in: 'editor', key: `layer-${i}` }))?.props as { label: string; variant: string } | undefined
    const text = (f1: string, f2: string) => `Here is "stack" from the pixel editor (2x2, 2 colours, 2 frames):\n\nFRAME 1\nGRID\n${f1}\n\nFRAME 2\nGRID\n${f2}\n\nPALETTE\nA=#ff004d\nB=#00e436\n\nEvery frame shows for 125 ms.\n`
    await ui.press({ key: 'tab-layers' })
    await ui.press({ key: 'layer-add' })
    expect(await chip(1)).toMatchObject({ label: 'Layer 2', variant: 'primary' })
    await ui.press({ key: 'c1' })
    await click(0, 0) // over layer 1's red
    await click(1, 1)
    await ui.press({ key: 'save' })
    expect(filled[0]!.text).toBe(text('B.\n.B', '.A\n..'))
    await ui.press({ key: 'layer-down' }) // under layer 1 now: its red shows again
    expect(await chip(0)).toMatchObject({ label: 'Layer 2', variant: 'primary' })
    await ui.press({ key: 'save' })
    expect(filled[1]!.text).toBe(text('A.\n.B', '.A\n..'))
    await ui.press({ key: 'layer-up' })
    await ui.press({ key: 'layer-hide' })
    expect((await chip(1))!.label).toBe('Layer 2 (hidden)')
    await click(1, 0)
    expect(await status(/Layer 2 is hidden/)).toBeDefined()
    await ui.press({ key: 'save' })
    expect(await status(/Hidden layers were left out/)).toBeDefined()
    expect(filled[2]!.text).toContain('FRAME 1\nGRID\nA.\n..\n')
    await ui.press({ key: 'layer-hide' }) // shown again
    await ui.press({ key: 'layer-lock' })
    await click(1, 0)
    expect(await status(/Layer 2 is locked/)).toBeDefined()
    await ui.press({ key: 'layer-lock' })
    await ui.press({ key: 'op-dn' })
    await ui.input({ key: 'layer-name', text: 'ink' })
    expect((await chip(1))!.label).toBe('ink (90%)')
    // At 90% the green over the red shows mixed and opaque; on its own it shows see-through.
    expect(await boxes(ui, (p) => /^#[0-9a-f]{6}80$/.test(p.backgroundColor || ''))).toBe(true)
    await ui.press({ key: 'save' }) // opacity is a working aid: Save is unchanged
    expect(filled[3]!.text).toBe(text('B.\n.B', '.A\n..'))
    await ui.press({ key: 'layer-merge' })
    expect(await chip(1)).toBeUndefined()
    expect(await chip(0)).toMatchObject({ label: 'Layer 1', variant: 'primary' })
    await ui.press({ key: 'save' })
    expect(filled[4]!.text).toBe(text('B.\n.B', '.A\n..'))
  })

  test('tilemap: the layer as distinct tiles, stamped cell by cell; any other edit ends it', async ($, on) => {
    const filled = host(on)
    const e = -1, grid = [[0, 1, 1, 0, e, e, e, e], [1, 0, 0, 1, e, e, e, e], [1, 0, 0, 1, e, e, e, e], [0, 1, 1, 0, e, e, e, e]]
    await $.tool.call({ tool: TOOL, palette: ['#112233', '#445566'], grid, name: 'tiles' })
    const { ui, click, status } = await editor($, 'terminal', 4)
    await ui.press({ key: 'tab-layers' })
    await ui.select({ key: 'tile-size', value: '4' })
    await ui.press({ key: 'tm-make' })
    expect(await status(/Tilemap: 1 distinct tile of 4x4 across 2 cells/)).toBeDefined()
    expect(await ui.find({ in: 'editor', key: 't-stamp' })).toBeDefined()
    await click(5, 1) // the empty cell takes tile #1
    await click(1, 1, { button: 'right' }) // the first cell empties
    await ui.press({ key: 'save' })
    expect(gridOf(filled[0]!.text)).toEqual(['....ABBA', '....BAAB', '....BAAB', '....ABBA'])
    await ui.press({ key: 't-brush' })
    await click(0, 0)
    expect(await ui.find({ in: 'editor', key: 't-stamp' })).toBeUndefined()
    expect(await ui.find({ in: 'editor', key: 'tm-make' })).toBeDefined()
  })

  test('a sprite wider than a narrow desktop pane keeps full-size pixels and scrolls across', async ($, on) => {
    const filled = host(on)
    await run($, '40x4')
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'Pane', requestId: PANE, props: pane(40, 40), viewport: { columns: 40, rows: 40 } })
    await ui.resize({ columns: 38, rows: 30, in: 'editor' })
    const status = (re: RegExp) => ui.find({ in: 'editor', type: 'Text', text: re })
    // The desktop reports whole cells, so half blocks (two pixels a cell) would leave every other row
    // out of reach: 2 columns a pixel, 19 of the 40 across.
    expect(await status(/half blocks/)).toBeUndefined()
    expect(await status(/columns 1-15 of 40/)).toBeDefined() // square pixels, 2.415 columns each
    expect(await boxes(ui, (p) => Math.abs((p.width || 0) - 15 * cellWidth(1, true)) < 0.01 && p.height === 1 && !p.backgroundColor)).toBe(true) // a blank row: one run of 15
    await ui.press({ key: 'c8' })
    await ui.press({ key: 'right' }) // half a pane across
    expect(await status(/columns 8-22 of 40/)).toBeDefined()
    await ui.pointer({ type: 'down', x: 1, y: 3, button: 'left', in: 'editor' })
    await ui.pointer({ type: 'up', x: 1, y: 3, button: 'left', in: 'editor' })
    await ui.key({ key: 'right', shift: true, in: 'editor' })
    expect(await status(/columns 15-29 of 40/)).toBeDefined()
    await ui.key({ key: 'right', shift: true, in: 'editor' })
    await ui.key({ key: 'right', shift: true, in: 'editor' }) // stops at the end
    expect(await status(/columns 26-40 of 40/)).toBeDefined()
    await ui.pointer({ type: 'down', x: 35, y: 0, button: 'left', in: 'editor' })
    await ui.pointer({ type: 'up', x: 35, y: 0, button: 'left', in: 'editor' })
    await ui.press({ key: 'zoom-out' }) // no half blocks to zoom out to
    expect(await status(/half blocks/)).toBeUndefined()
    // Under the 4 canvas rows, the whole sprite small: a press there centres the view on that column.
    expect(await ui.find({ in: 'editor', key: 'overview' })).toBeDefined()
    await ui.pointer({ type: 'down', x: 0, y: 5, button: 'left', in: 'editor' })
    await ui.pointer({ type: 'up', x: 0, y: 5, button: 'left', in: 'editor' })
    expect(await status(/columns 1-15 of 40/)).toBeDefined()
    await ui.pointer({ type: 'down', x: 18, y: 5, button: 'left', in: 'editor' })
    await ui.pointer({ type: 'up', x: 18, y: 5, button: 'left', in: 'editor' })
    expect(await status(/columns 13-27 of 40/)).toBeDefined()
    await ui.press({ key: 'save' })
    const rows = gridOf(filled[filled.length - 1]!.text)
    expect(rows[3]![7]).not.toBe('.')
    expect(rows[0]![39]).not.toBe('.')
    expect(rows.join('').replace(/\./g, '')).toHaveLength(2)
    await ui.unmount()
  })

  test('colour picker: shown with the Colour tab; the square sets saturation and brightness, the strip the hue, for FG or BG', async ($, on) => {
    host(on)
    await run($, '4x3')
    for (const surface of SURFACES) {
      const { ui } = await editor($, surface, 4)
      const label = async (key: string) => (await ui.find({ in: 'editor', key }))!.text
      const press = async (x: number, y: number) => {
        await ui.pointer({ type: 'down', x, y, button: 'left', in: 'editor' })
        await ui.pointer({ type: 'up', x, y, button: 'left', in: 'editor' })
      }
      const title = await ui.find({ type: 'Link' })
      expect(title?.props).toMatchObject({ href: 'https://www.spriteforge.tech' })
      expect(await ui.find({ type: 'Text', text: 'SpriteForge.tech' })).toBeDefined()
      // A 4x3 sprite at zoom 4 takes 12 rows; the picker starts one under: 9 rows of square, then the
      // hue strip, 40 steps of one column.
      const top = 13
      await press(0, top + 9) // the strip's first step: red
      await press(39, top) // the square's top right: full saturation and brightness
      expect(await label('target-fg')).toContain('#ff0000')
      expect(await ui.find({ in: 'editor', type: 'Text', text: '◆' })).toBeDefined()
      await press(0, top + 8) // bottom left
      expect(await label('target-fg')).toContain('#000000')
      await press(39, top)
      // A drag that starts on the strip stays the hue's, wherever it goes: step 20 of 40 is cyan.
      await ui.pointer({ type: 'down', x: 0, y: top + 9, button: 'left', in: 'editor' })
      await ui.pointer({ type: 'move', x: 20, y: top + 3, button: 'left', in: 'editor' })
      await ui.pointer({ type: 'up', x: 20, y: top + 3, button: 'left', in: 'editor' })
      expect(await label('target-fg')).toContain('#00ffff')
      await ui.press({ key: 'target-bg' })
      await press(0, top + 8)
      expect(await label('target-bg')).toContain('#000000')
      expect(await label('target-fg')).toContain('#00ffff')
      // Other tabs hide it, and Picker hides it on the Colour tab too.
      await ui.press({ key: 'tab-canvas' })
      expect(await ui.find({ in: 'editor', type: 'Text', text: '◆' })).toBeUndefined()
      await ui.press({ key: 'tab-colour' })
      await ui.press({ key: 'picker' })
      expect(await ui.find({ in: 'editor', type: 'Text', text: '◆' })).toBeUndefined()
      await ui.press({ key: 'picker' })
      await ui.unmount()
    }
  })

  test('frames: add, duplicate, move, delete, onion skin both ways, frame times, fps, playback, tags', async ($, on) => {
    const filled = host(on)
    await run($, '4x3')
    const { ui, click, status } = await editor($, 'terminal', 4)
    const frame = (label: string) => ui.find({ in: 'editor', type: 'Text', text: new RegExp(`^frame ${label}$`) })
    const ghost = async () => ((await ui.findAll({ in: 'editor', type: 'Text', text: /^▒+/ })).map((g) => g.props.color))
    await ui.press({ key: 'c8' })
    await click(0, 0)
    await ui.press({ key: 'tab-frames' })
    await ui.press({ key: 'frame-add' })
    expect(await frame('2/2')).toBeDefined()
    expect(await ghost()).toEqual([])
    await ui.press({ key: 'onion' }) // frame 1's pixel shows faintly, red: behind
    expect(await ghost()).toEqual(['#e08a95'])
    await click(1, 0)
    await ui.press({ key: 'frame-dup' })
    await click(2, 0)
    await ui.press({ key: 'frame-left' })
    expect(await frame('2/3')).toBeDefined()
    await ui.press({ key: 'onion-back' }) // 2 behind
    await ui.press({ key: 'onion-fwd' }) // 1 ahead, green
    expect(await ghost()).toEqual(['#e08a95'])
    await ui.press({ key: 'frame-add' })
    expect(await ghost()).toContain('#7ed08a')
    await ui.press({ key: 'frame-del' })
    expect(await frame('2/3')).toBeDefined()
    await ui.input({ key: 'ms', text: '300' })
    expect(await status(/Frame 2 shows for 300 ms/)).toBeDefined()
    await ui.press({ key: 'fps-up' })
    await ui.press({ key: 'fps-up' }) // 10 fps: 100 ms a frame
    await ui.press({ key: 'play' }) // from the first frame
    expect(await frame('1/3')).toBeDefined()
    await ui.advance(100)
    expect(await frame('2/3')).toBeDefined()
    await ui.advance(299)
    expect(await frame('2/3')).toBeDefined()
    await ui.advance(1)
    expect(await frame('3/3')).toBeDefined()
    await ui.advance(100)
    expect(await frame('1/3')).toBeDefined()
    await ui.press({ key: 'play' }) // stops, back on the frame being edited
    expect(await frame('2/3')).toBeDefined()
    await ui.input({ key: 'tag', text: 'walk 2-3' })
    expect(await status(/Tag "walk": frames 2-3/)).toBeDefined()
    await ui.press({ key: 'tag-0' }) // loops frames 2-3
    expect(await frame('2/3')).toBeDefined()
    await ui.advance(300)
    expect(await frame('3/3')).toBeDefined()
    await ui.advance(100)
    expect(await frame('2/3')).toBeDefined()
    await ui.press({ key: 'tag-0' })
    await ui.press({ key: 'save' })
    expect(filled[0]!.text).toBe('Here is "sprite" from the pixel editor (4x3, 1 colour, 3 frames):\n\n' +
      'FRAME 1\nGRID\nA...\n....\n....\n\nFRAME 2\nGRID\n.AA.\n....\n....\n\nFRAME 3\nGRID\n.A..\n....\n....\n\nPALETTE\nA=#ff004d\n\n' +
      'Frame times (ms): 1=100, 2=300, 3=100. Tags: walk = frames 2-3.\n')
    await ui.press({ key: 'untag-0' })
    await ui.press({ key: 'save' })
    expect(filled[1]!.text).not.toContain('Tags:')
  })

  test('export: PNG, 8x, GIF, Aseprite, text and frames are written beside the sprite, never over a file', async ($, on) => {
    const out = host(on)
    await run($, 'art/hero.png')
    const { ui, status } = await editor($, 'terminal', 2)
    await ui.press({ key: 'tab-export' })
    await ui.press({ key: 'export-png' })
    expect(await status(/^Wrote art\/hero-2\.png\.$/)).toBeDefined()
    expect(out.runs[0]!.slice(0, 2)).toEqual(['/bin/sh', '-c'])
    const one = spriteFromPng(out.files.get('art/hero-2.png') as Uint8Array, 64, 256)
    const letters = (s: typeof one) => Array.from({ length: s.h }, (_, y) => s.grid.slice(y * s.w, y * s.w + s.w).map((v) => (v < 0 ? '.' : 'ABCD'[['#6ea8fe', '#dcb684', '#17161d', '#c82828'].indexOf(s.palette[v]!)])).join(''))
    expect(letters(one)).toEqual(HERO_GRID)
    await ui.press({ key: 'export-png8' })
    const big = spriteFromPng(out.files.get('art/hero@8x.png') as Uint8Array, 512, 256)
    expect([big.w, big.h]).toEqual([104, 72])
    await ui.press({ key: 'export-gif' })
    expect(String.fromCharCode(...(out.files.get('art/hero.gif') as Uint8Array).slice(0, 6))).toBe('GIF89a')
    // Both are signed, as image editors sign their files: a PNG's Software text, a GIF's comment.
    const text = (k: string) => String.fromCharCode(...(out.files.get(k) as Uint8Array))
    expect(text('art/hero-2.png')).toContain('tEXtSoftware\0SpriteForge Editor (https://www.spriteforge.tech)')
    expect(text('art/hero.gif')).toContain('SpriteForge Editor (https://www.spriteforge.tech)')
    await ui.press({ key: 'export-ase' })
    const ase = out.files.get('art/hero.aseprite') as Uint8Array
    expect([ase[4], ase[5]]).toEqual([0xe0, 0xa5])
    await ui.press({ key: 'export-txt' })
    expect(String(out.files.get('art/hero.txt'))).toMatch(/^# hero · 13x9\na = #6ea8fe\n/)
    await ui.press({ key: 'export-sheet' })
    expect(await status(/A sheet needs 2\+ frames/)).toBeDefined()
    await ui.press({ key: 'tab-frames' })
    await ui.press({ key: 'frame-dup' })
    await ui.press({ key: 'tab-export' })
    await ui.press({ key: 'export-frames' })
    expect(await status(/^Wrote art\/hero_01\.png and art\/hero_02\.png\.$/)).toBeDefined()
    await ui.press({ key: 'export-sheet' })
    expect(spriteFromPng(out.files.get('art/hero_sheet.png') as Uint8Array, 64, 256).w).toBe(26)
  })

  test("export without a base64 decoder hands the pixels to Claude to write", async ($, on) => {
    const out = host(on, { decoder: false })
    await run($, '2x1')
    const { ui, click, status } = await editor($, 'terminal', 4)
    await ui.press({ key: 'c8' })
    await click(0, 0)
    await ui.press({ key: 'tab-export' })
    await ui.press({ key: 'export-png8' })
    // Full paths only: a bare name could run a same-named program from the project folder.
    expect(out.runs.map((r) => r[0])).toEqual([WRITERS.sh, WRITERS.powershell, WRITERS.pwsh])
    expect(Object.values(WRITERS).every((p) => p.startsWith('/') || /^[A-Z]:\\/.test(p))).toBe(true)
    expect(await status(/Couldn't write sprite@8x\.png here \(no base64 tool\)/)).toBeDefined()
    expect(out[0]!.text).toBe('Write "sprite" to sprite@8x.png as a PNG at 8x (nearest neighbour):\n\nGRID\nA.\n\nPALETTE\nA=#ff004d\n')
  })

  test('sprites with more colours than letters go to the prompt as JSON', () => {
    const palette = Array.from({ length: 70 }, (_, i) => '#' + i.toString(16).padStart(6, '0'))
    const text = spriteText('rainbow', null, 70, 1, palette, [Array.from({ length: 70 }, (_, i) => i)])
    expect(text).toContain('```json')
    expect(text).toContain('(70x1, 70 colours)')
  })
})
