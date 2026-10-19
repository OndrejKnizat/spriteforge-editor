// The sprite open in the editor pane. Frames are row-major strings of w*h cells: "." is a
// transparent pixel, any other character the palette index String.fromCharCode(0x100 + index).
export type DrawDoc = {
  rev: number
  name: string
  path: string | null
  w: number
  h: number
  palette: string[]
  frames: string[]
  // A tile of the open tileset, brought here by the tile editor's "Open in pixel editor": the
  // pane then has "Back to tiles".
  back?: { mask: number; tilesRev: number } | null
}

// The tileset open in the tile editor pane: a Wang set's 16 tiles in mask order (hooks/wang.ts),
// previewed flat, as walls or isometric, or a platformer set's 49 in SpriteForge's order; tile x
// tile each on one palette, encoded as DrawDoc frames are. `source` says where it came from, and so
// how Save lays it out: a 16x1 strip stays a strip; any other Wang set becomes a 4x4 sheet, a
// platformer set a 7x7 one.
export type TileDoc = {
  rev: number
  name: string
  path: string | null
  kind: 'wang' | 'platformer'
  view: 'flat' | 'wall' | 'iso'
  source: 'sheet' | 'strip' | 'texture' | 'draft' | 'blank'
  tile: number
  palette: string[]
  tiles: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'spriteforge-editor': {
      doc: DrawDoc | null
      tiles: TileDoc | null
      notice: { id: number; text: string } | null
      // A tile coming back from the pixel editor to the tile editor.
      tileBack: { id: number; mask: number; palette: string[]; art: string } | null
    }
  }
}
