# SpriteForge Editor

SpriteForge's free pixel editor and tileset editor, inside Claude. Hand-edit a sprite, an animation or
a Wang autotile tileset right in the conversation, then hand the result back to Claude, who can write it
into your project's files. No account needed.

It's the hand-editing half of [SpriteForge](https://www.spriteforge.tech), an AI pixel-art studio that
generates game-ready sprites, animations and tilesets from a prompt.

- **In Claude's chat apps** (claude.ai on the web, the Claude desktop app's chat): the editor opens as
  an interactive card in the conversation.
- **In Claude Code and Cowork:** Claude gives you an edit link that opens the editor in your browser,
  and writes your edits back into the file when you say you're done.

This is the copy of the plugin listed in Claude's plugin directory: the connector, a skill and a
command. The full plugin on this repository's `main` branch adds pixel and tile editor panes beside the
conversation in Claude Code - see [Editor panes in Claude Code](#editor-panes-in-claude-code).

## Install

- **Claude's plugin directory:** add SpriteForge Editor from the directory.
- **claude.ai:** add the connector `https://www.spriteforge.tech/mcp/editor` (Settings, Connectors).
- **From a checkout, without installing:** `claude --plugin-dir path/to/spriteforge-editor`.

## Example prompts

- "Draw a 16x16 health potion and open it in the SpriteForge editor so I can touch it up."
- "Open a blank 32x32 canvas in the full SpriteForge editor - I want layers and animation frames."
- "Make a 16px grass Wang tileset and open it in the tileset editor so I can paint a test map."
- "Show that tileset as isometric terrain."
- In Claude Code: "Open assets/hero.png in the SpriteForge editor" (or `/spriteforge-editor:edit assets/hero.png`),
  then "I'm done - write my edits back".
- "I'm done - show me the result and give me the PNG." (Claude reads the sprite back with `get_sprite`.)

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

Ask Claude to open a sprite from your project, or use `/spriteforge-editor:edit assets/hero.png`: it
uploads the PNG to an edit link, gives you the link, and when you say you're done it checks what changed
and writes the edited pixels back into the file. The link opens SpriteForge's Edit studio in your
browser with no sign-in, and every stroke saves to the link.

### Editor panes in Claude Code

The full plugin, published on this repository's `main` branch, also opens the pixel editor and the tile
editor as panes beside the conversation in Claude Code, on your machine, with nothing uploaded. To use
it instead of this copy:

- **Claude Code, terminal:** `/plugin marketplace add OndrejKnizat/spriteforge-editor`, then
  `/plugin install spriteforge-editor@spriteforge-editor`. Installed at the user scope, it also loads in
  the desktop app's Code tab.
- **Claude Code, desktop app:** click **+** next to the prompt box, then **Plugins**, **Add marketplace**
  with `OndrejKnizat/spriteforge-editor`, then **Add plugin** and pick `spriteforge-editor`.

The panes are a Claude Code mod: code that runs on your machine with your permissions. Its README on
`main` lists everything the mod reads, writes and runs.

## What it sends and stores

- **Edit links and the chat cards** upload the sprite you edit (its pixels, palette and a name) to
  spriteforge.tech, where it is stored under an unguessable edit link. Anyone holding the link can view
  and edit that sprite. Edit links aren't tied to an account. A link stops working 24 hours after the
  last edit (7 days after it was created at most), and its sprite is deleted within a day after that.
- In Claude Code the upload and download are plain `curl` requests to
  `https://www.spriteforge.tech/api/edit-session`. The connector, `https://www.spriteforge.tech/mcp/editor`,
  creates and reads edit links the same way. The cards are self-contained and load nothing from other
  sites. Nothing else on your machine is read or sent.
- The plugin runs no code of its own on your machine: it has no hooks, scripts or programs, and it
  reads no tokens, keys or other credentials.

Limits: edit links and cards take PNGs up to 128x128 pixels and 256 colours; pixels under 50% opacity
become transparent.

## Troubleshooting

- **No editor card appears:** cards show in Claude's chat apps (claude.ai on the web and the desktop
  app's chat). Elsewhere, open the edit link Claude gives you. Check that the SpriteForge Editor
  connector is turned on for the conversation, or name it in your request ("in the SpriteForge editor").
- **"That edit session has expired":** edit links close 24 hours after the last edit. Ask Claude to open
  the sprite again; if you still have the PNG, it starts a new link from it.
- **"Too many new edit sessions right now":** the free connector is rate-limited. Wait a few minutes.
- **The sprite is too big:** edit links and cards take up to 128x128 pixels and 256 colours. Crop or
  reduce the colours first.

## Components

- `.mcp.json` - the **SpriteForge Editor** connector (`/mcp/editor`, no sign-in): `open_editor`,
  `get_sprite`, `open_full_editor` and `open_tileset_editor`, the three editor cards (MCP Apps: the
  compact editor, the full Edit studio and the tileset editor) and the two tools only the cards call,
  `load_art` and `save_art`.
- `skills/edit-sprite` - tells Claude when and how to open each editor and bring results back;
  `commands/edit.md` - `/spriteforge-editor:edit <file>`.

## Links

- Privacy policy: https://www.spriteforge.tech/privacy.html
- Terms: https://www.spriteforge.tech/terms.html
- Support: support@spriteforge.tech
