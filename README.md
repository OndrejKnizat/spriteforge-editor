# SpriteForge Editor

SpriteForge's free pixel editor and tileset editor, inside Claude. Hand-edit a sprite, an animation or
a Wang autotile tileset right in the conversation, then hand the result back to Claude, who can write it
into your project's files. No account needed.

It's the hand-editing half of [SpriteForge](https://www.spriteforge.tech), an AI pixel-art studio that
generates game-ready sprites, animations and tilesets from a prompt. To generate from Claude as well, add
the separate [SpriteForge plugin](https://github.com/OndrejKnizat/spriteforge-claude-plugin) (it runs on
a SpriteForge account).

- **In Claude's chat apps** (claude.ai on the web, the Claude desktop app's chat): the editor opens as
  an interactive card in the conversation.
- **In Claude Code** (a terminal, or the Code tab of the Claude desktop app): the editor opens as a pane
  beside the conversation, running on your machine.

## Install

- **Claude Code, terminal:** `/plugin marketplace add OndrejKnizat/spriteforge-editor`, then
  `/plugin install spriteforge-editor@spriteforge-editor`. Installed at the user scope, it also loads in
  the desktop app's Code tab.
- **Claude Code, desktop app:** click **+** next to the prompt box, then **Plugins**, **Add marketplace**
  with `OndrejKnizat/spriteforge-editor`, then **Add plugin** and pick `spriteforge-editor`.
- **From a checkout, without installing:** `claude --plugin-dir path/to/spriteforge-editor`; for the
  desktop app, put the folder's absolute path in `CLAUDE_CODE_PLUGIN_DIRS` under `env` in
  `~/.claude/settings.json` and restart the app.
- **claude.ai:** add the connector `https://www.spriteforge.tech/mcp/editor` (Settings, Connectors).

## In Claude's chat apps

Ask Claude to open a sprite, pixel art it drafted or a blank canvas in the editor. The **editor card**
has a pencil, eraser, fill, colour picker, palette, undo and animation frames; **Done** hands the result
back to Claude. **Open full editor** brings up SpriteForge's whole Edit studio in the conversation -
layers, selection, shapes, mirror painting, palette tools, frames with onion skin and playback - on the
same sprite. For a tileset, the **tileset card** is SpriteForge's tileset window: paint a small map to
watch the tiles join up, draw on the map or on single tiles, and edit the base texture, which
re-derives every edge tile you haven't drawn on by hand (Wang sets, also previewed as walls or
isometric, and 49-tile platformer sets). Claude can give you an edit link for the browser instead.

## In Claude Code

Two panes open beside the conversation, and Claude can open them for you with a file or with art it
drafted. Neither uploads anything. For the browser Edit studio, ask Claude for an edit link
(`/spriteforge-editor:edit assets/hero.png`): it uploads the PNG, gives you the link, and writes the
edited pixels back into the file when you say you're done.

### Pixel editor pane

- `/spriteforge-draw assets/hero.png` opens a PNG from your project (up to 64x64 pixels and 256
  colours; pixels under 50% opacity count as transparent).
- `/spriteforge-draw 32x32` opens a blank canvas; `/spriteforge-draw` alone is 16x16.
- Claude can open it for you too, with a file or with pixel art it drafted (the `open_pixel_editor`
  tool).

In the editor - the tools of SpriteForge's Edit studio, with its keys. The toolbar groups them (paint,
shapes, select); the line under it says what the chosen tool does and its key, and **Keys** shows every
shortcut:

- **Draw:** Brush, Eraser, Fill, Pick, Shade, Line, Rect, Oval (keys B, E, G, I, S, L, U, Shift+U).
  Right-click paints the background colour (transparent: erases), Shift+click draws a line from the
  last point, Alt+click picks a colour. The brush is 1-8 pixels, round or square (`[` `]`), with
  **Pixel-perfect** freehand at 1 pixel and **Mirror X / Y** painting; Shade darkens (right-click
  lightens) at 4-40%; Fill can be **Global** (every pixel of that colour); U and Shift+U again
  switch outline and filled shapes.
- **Select, Wand, Lasso** (M, W, Q): Shift adds, right-click takes away, and painting keeps inside the
  selection. Drag inside it to move the pixels (Alt or Ctrl+drag moves a copy), a corner to scale
  them, just outside a corner to turn them (Shift snaps to 15°; **Pivot** sets the centre); arrows
  nudge, Enter sets them down. Copy, Cut, Paste, Delete, Deselect (Ctrl+C, X, V, Delete, Ctrl+D),
  Ctrl+A, **Crop**, **To brush** (Ctrl+B: the selection becomes a custom brush), **Flip** and **Rotate
  90°** (Shift+H, Shift+V), on the selection or the current layer. **Move** (V) slides the layer.
- **Colour:** foreground and background (X swaps), the **Picker** (a saturation and brightness square
  over a hue strip, under the canvas; click or drag), a hex field and hue / saturation / value steps;
  palette **Add**, **Remove** (its pixels clear), **Sort** by brightness, **DB32**, **Reduce to** N
  colours (Keep or Revert), and **Edit swatch** to recolour every pixel of a swatch at once.
- **Canvas:** resize without scaling (anchored at any corner, side or the middle, or around the art),
  **Resample**, **Trim**, **Crop to selection**, **Outline** (dark-tinted, black or white),
  **Strip outline**, **Remove BG**, **Offset ½**, **Tidy** (fills pin-holes), **Tile 3x3** to check a
  texture tiles (painting wraps), and the empty-pixel backdrop (transparent, dots, a checker, or the sprite plate from
  spriteforge.tech).
- **Layers:** add, hide, lock, rename, raise, lower, merge down, delete, and a see-through opacity
  while you work (Save is unaffected). **Make tilemap** turns the layer into its distinct tiles, which
  **Stamp** puts cell by cell.
- **Frames:** add, duplicate, delete and reorder; each frame's own time in ms or the fps (1-24);
  **Play** (Space); **Onion** with up to 3 frames behind (red) and ahead (green); **tags** ("walk
  1-4") that loop just their frames. Left and Right step through frames.
- **Export** writes files beside the sprite, never over one that is there: PNG at 1x or 8x, a sheet
  of every frame, a looping GIF, each frame as an 8x PNG, Aseprite (layers and frames), or a text grid.
- Ctrl+Z / Ctrl+Shift+Z undo and redo; `+` `-` `0` and `1`-`5` zoom; Up and Down scroll a tall sprite.
  **Grid** beside the zoom buttons toggles a pixel grid (hairlines in the desktop app, alternate pixels
  tinted in a terminal).
  **Save to prompt** flattens the visible layers into your prompt, with the frame times and tags.

Exact clicks on large sprites (drawn two pixels per character) need a terminal that reports pixel
positions: kitty, Ghostty, iTerm2, WezTerm or foot. In the desktop app a sprite too wide for the pane
keeps full-size pixels and scrolls across instead (◀ ▶, or Shift+Left / Right), with the whole sprite
small under the canvas: click it to move the view there.

### Tile editor pane

SpriteForge's tileset window, for a 16-tile Wang terrain set (dual-grid autotiles: tile *i* is drawn
where the map cells at its corners are painted, NW=1, NE=2, SW=4, SE=8, so tile 15 is the solid base
texture) or a 49-tile platformer set.

- `/spriteforge-tiles grass.png` opens a set exported from SpriteForge: a 4x4 sheet, or the 16x1
  strip the connector downloads. A square texture instead makes a new set from it, the way SpriteForge
  derives one. `/spriteforge-tiles 16` starts a grass placeholder with 16px tiles. Add `wall` or `iso`
  to preview the set as walls or isometric, or `platformer` for a platformer set (a 7x7 sheet PNG, or
  a size for a blank one): `/spriteforge-tiles 16 platformer`.
- Claude can open it too (the `open_tile_editor` tool), with a file, a drafted texture or drafted tiles.

In the editor:

- **Paint map** paints terrain cells on a small map (right-click clears them) so you can watch the
  tiles join up. **Edit pixels** draws on the map itself: each stroke lands in the tile under it, so
  every repeat of that tile follows. Right-click there picks a colour. Keys M and P switch. **View**
  previews the map flat, as walls or isometric (cells paint in every view; pixels on the flat map).
- **Edit a tile** opens any of the 16 tiles at full size (Brush, Eraser, Fill, Pick; keys B, E, G, I;
  the line under them says what the chosen one does, and **Keys** shows every shortcut). **Base texture**
  opens the base: **Offset ½** brings its seams to the middle, and **Done** derives every edge tile
  from it again, keeping any you drew by hand. **Previous version** brings back a tile as it was before
  its last Done. **Open in pixel editor** takes the tile to the pixel editor pane, with every tool
  there; its **Back to tiles** brings it back for Done.
- A platformer set shows its 7x7 sheet: click a tile to edit it, or **Edit pixels** to draw on the sheet.
- Ctrl+Z / Ctrl+Shift+Z undo and redo; `+` and `-` zoom (big tiles show at 1/2 or 1/4 size while you
  paint cells); **Grid** toggles a pixel grid, as in the pixel editor; **Save to prompt** sends the set
  as one sheet, laid out as it came.
- In the desktop app, as in the pixel editor, a sheet or tile too wide for the pane keeps full-size
  pixels and scrolls across (◀ ▶, or Shift+Left / Right), with the whole of it small under the canvas.

## What it sends and stores

- **The panes (Claude Code)** read only the PNG you name, on your machine, and decode it locally.
  Nothing is uploaded: the edited sprite goes into your own prompt box, and you decide whether to send
  it. **Export** writes files into your project; image files go through your system's base64 decoder
  (`sh` with `base64` on macOS and Linux, PowerShell on Windows), and where there is none the pixels
  go to your prompt for Claude to write instead. They are a Claude Code mod, so their code runs with your permissions like any plugin; it is all in
  `hooks/`.
- **Edit links and the chat cards** upload the sprite you edit (its pixels, palette and a name) to
  spriteforge.tech, where it is stored under an unguessable edit link. Anyone holding the link can view
  and edit that sprite. Edit links aren't tied to an account and are deleted 24 hours after the last
  edit, and never kept more than 7 days.
- In Claude Code the upload and download are plain `curl` requests to
  `https://www.spriteforge.tech/api/edit-session`. The connector, `https://www.spriteforge.tech/mcp/editor`,
  creates and reads edit links the same way. The cards are self-contained and load nothing from other
  sites. Nothing else on your machine is read or sent.

Limits: edit links take PNGs up to 128x128 pixels and 256 colours, the panes up to 64x64; pixels under
50% opacity become transparent.

## Components

- `.mcp.json` - the **SpriteForge Editor** connector (`/mcp/editor`, no sign-in): `open_editor`,
  `get_sprite`, `open_full_editor` and `open_tileset_editor`, the three editor cards (MCP Apps: the
  compact editor, the full Edit studio and the tileset editor) and the two tools only the cards call,
  `load_art` and `save_art`.
- `hooks/` - the Claude Code mod: the pixel editor pane (`editor.tsx`, its sprite model and edits in
  `sprite.ts`, the Edit studio's pixel tools ported in `tools.ts`), the tile editor pane (`tiles.tsx`),
  their shared drawing code (`pixels.tsx`), SpriteForge's Wang tile maths (`wang.ts`), a PNG decoder
  (`png.ts`), the PNG / GIF / Aseprite writers (`encode.ts`), and `register.tsx`, which adds `/spriteforge-draw`, `/spriteforge-tiles` and
  the `open_pixel_editor` and `open_tile_editor` tools.
- `skills/edit-sprite` - tells Claude when and how to open each editor and bring results back;
  `commands/edit.md` - `/spriteforge-editor:edit <file>`.

## Develop

`claude plugin validate .`, `claude plugin test .` (the tests drive both panes, the mouse and Save on
the terminal and desktop surfaces). `hooks/wang.ts` is a port of SpriteForge's `app/engine/wang.js`;
the tile tests check it against sets that engine made.

## Links

- Privacy policy: https://www.spriteforge.tech/privacy.html
- Terms: https://www.spriteforge.tech/terms.html
- Support: support@spriteforge.tech
