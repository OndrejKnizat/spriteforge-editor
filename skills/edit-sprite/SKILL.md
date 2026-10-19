---
name: edit-sprite
description: Open pixel art, a game sprite (PNG) or a Wang autotile tileset in SpriteForge's free pixel editor or tileset editor so the user can tweak it by hand, then bring the edited result back. Use when the user wants to hand-edit, touch up, fix pixels on, recolour by hand or draw a sprite, tile, tileset or icon, or asks for a pixel editor. No account needed.
---

# Hand-edit sprites and tilesets with SpriteForge

SpriteForge's editor is a full pixel editor: brush, eraser, fill, line and shapes, selection, palette
tools, layers and animation frames, with Aseprite-style keys. It reaches the user three ways:

- **In Claude Code (terminal or the desktop app's Code tab):** this plugin's panes open beside the
  conversation, nothing uploaded - see "Panes in Claude Code" below.
- **In the browser:** an **edit link** opens one sprite in SpriteForge's Edit studio with no sign-in,
  and every stroke saves to the link automatically.
- **In Claude's chat apps (claude.ai on the web and desktop):** the editor appears in the conversation
  as a card - see "Without a shell" below.

## Panes in Claude Code

When the `open_pixel_editor` and `open_tile_editor` tools are available, prefer them for quick hand
edits: they open a pane beside the conversation on the user's machine, read the PNG locally and send
nothing anywhere.

- `open_pixel_editor` - a sprite or animation: `path` to a PNG (up to 64x64), or `palette` + `grid` /
  `frames` you drafted, or `width` + `height` for a blank canvas. The pane has the tools of
  SpriteForge's Edit studio: brushes, shade, shapes, selection (wand, lasso, scale, rotate), palette
  tools, canvas resize and outline tools, layers, frames with timing, tags, onion skin and playback.
  Its **Export** tab writes PNG, GIF, sheet, per-frame PNGs or Aseprite files beside the sprite itself;
  if the user did that, the file is already there.
- `open_tile_editor` - a tileset, SpriteForge's tileset window: `kind` wang (default; `wall` and `iso`
  preview it as walls or isometric) or platformer. A Wang set: `path` to a tileset PNG (SpriteForge's
  4x4 sheet or 16x1 strip, or a square texture to derive one from), `palette` + `tiles` (16 grids, tile
  i drawn where the map cells at its corners are painted, NW=1 NE=2 SW=4 SE=8) or `palette` + `base`,
  or `size`. A platformer set: `path` to its 7x7 sheet, `palette` + `tiles` (49 grids in SpriteForge's
  order), or `size` for a blank one.
- Both return at once. When the user clicks **Save to prompt**, the result arrives in their next message
  as a GRID + PALETTE block (one letter per pixel, "." transparent; an animation also lists its frame
  times and tags); write it back to the file if they ask (PNG encoding is up to you - a short script
  with your usual tools). A message starting "Write ... as ..." is an export the pane couldn't write
  on this machine: write that file.
- If the tool reports that no surface can show the pane (Claude Code on the web, the phone apps), use an
  edit link instead.
- For bigger sprites (up to 128x128) or the full Edit studio in the browser, use an edit link.

## Edit links (with a shell and the file on disk)

**What leaves the machine (edit links and the chat cards):** the sprite's pixels and palette go to spriteforge.tech and are kept under
an unguessable link until it closes, 24 hours after the last edit (7 days at most). Anyone holding the
link can view and edit that sprite. Tell the user this the first time you upload one of their files.

**Limits:** PNG up to 128x128 pixels and 256 colours. Pixels under 50% opacity become fully
transparent; partial transparency isn't kept. Larger images (big sprite sheets, maps) can't be opened
yet - say so rather than shrinking them.

1. Upload the file. Don't paste base64 into a tool call; let curl send the bytes:

   ```bash
   curl -sS --data-binary @"assets/hero.png" -H 'Content-Type: image/png' \
     'https://www.spriteforge.tech/api/edit-session?name=hero'
   ```

   The JSON response carries `id`, `editUrl` and `pngUrl`. Name the session after the file.

2. Give the user the `editUrl` and ask them to tell you when they're done. Open it in their browser
   (`open` on macOS, `xdg-open` on Linux) only if they ask; on a remote or cloud machine, just share
   the link.

3. When they're done, check what changed before touching the file: call the `get_sprite` tool with the
   `id` (it shows you a preview and how many saves happened). If it reports no saves, ask before
   overwriting anything.

4. Write the result back over the original - that's the file they asked to edit. If the file isn't
   under version control, copy it to a backup first and say where.

   ```bash
   curl -sS -f -o "assets/hero.png.new" '<pngUrl>' && mv "assets/hero.png.new" "assets/hero.png"
   ```

   Download to a temporary name and move it into place only on success, so an expired link or a
   network error can never leave a truncated sprite behind.

   `pngUrl` returns the exact pixels at 1x with real transparency. For an animation, add `&frame=N`
   (0-based) to get each frame.

## Without a shell (claude.ai and other chat apps)

Use the SpriteForge Editor connector's tools. Where the app supports interactive cards (claude.ai on
the web and desktop), the editor appears right in the conversation under the `open_editor` call: the
user draws there, can switch to the full editor, and clicks **Done**, which sends you a message with
the `session_id`. Elsewhere the user gets the edit link instead.

- When the user wants the whole Edit studio in the conversation (layers, selection, shapes, mirror
  painting, frames with onion skin), call `open_full_editor` directly, with the same sources as
  `open_editor` (`png_base64`, `art`, or a size) - don't open the compact editor first. For a sprite
  that's already open, pass its `session_id` instead; the compact card's **Open full editor** button
  asks you for exactly this.
- For a tileset, call `open_tileset_editor` instead: SpriteForge's tileset window in the conversation
  (the user paints a small map to see the tiles chain, draws on the map or on single tiles, and edits
  the base texture, which re-derives every edge tile they haven't drawn on by hand). `kind` is `wang`
  (16 dual-grid autotiles; also `wall` and `iso`, the same 16 tiles previewed as walls or isometric) or
  `platformer` (49 tiles). Give `base` (one seamless texture grid; the 16 Wang tiles are derived from
  it as SpriteForge does), `tiles` (every tile, in mask order: tile i is drawn where the map cells at
  its corners are painted, NW=1 NE=2 SW=4 SE=8, so 15 is the solid base), `png_base64` (a sheet, a
  strip or a square texture), or only `size` for a blank set. `get_sprite` on its `session_id` shows the
  set as one sheet; its edit link opens the same window on spriteforge.tech.
- `open_editor` opens a sprite and returns the edit link to share. Pass `png_base64` when you have the
  PNG's bytes, `art` when you're handing over pixel art you drafted (a palette of hex colours plus a
  grid of palette indexes, -1 for transparent), or only `width` and `height` for a blank canvas.
- If the user has an image you can see but can't pass as bytes, open the full editor on a blank canvas
  at its size (`open_full_editor` with `width` and `height`) and tell them to drag their PNG onto it -
  it imports into the same link. (The compact card doesn't take dropped files.)
- When they're done (or the card's Done message arrives), `get_sprite` with the `session_id` shows you
  the result and gives the PNG URL they can download. If they paste an edit link instead, pass that;
  the tool reads the id out of it.

## Keeping it in the user's SpriteForge library

If the signed-in **SpriteForge** connector is available, the user can keep what they edited:

- After editing, offer `save_to_library` with the `session_id` (it goes into their most recently used
  project unless they pick one with `project_id`; `list_projects` shows them).
- To touch up a sprite that's already in their library, use `open_sprite_in_editor` with its
  `asset_id` instead of `open_editor` (or `open_full_editor` with the `asset_id` to open it straight in
  the full editor), then `save_to_library` with the returned `session_id` when they're done - that
  updates the library sprite and keeps the old version in its history.
- Saving the same session again updates the sprite it created rather than making a copy.
- The same connector can also generate sprites with AI on the user's credits - see the
  generate-sprites skill.

## Good to know

- You can draft small pixel art yourself as `art` (up to about 32x32 is practical to write) and let
  the user refine it by hand.
- The editor's AI features cost credits and need a SpriteForge account. Hand-editing never does; don't
  suggest signing up unless the user asks for AI edits or generation.
