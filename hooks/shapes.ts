// Shapes the .tsx modules share. They live in a .ts file because the directory refuses a .tsx file
// that declares anything named h (JSX compiles to calls of h), and a sprite's height is `h`.

// A picture's size in pixels.
export type Size = { w: number; h: number }

// What the pixel editor pane posts: Send to Claude ('save'), Back to tiles ('back') or Export.
export type EditorPost = {
  type?: string
  w?: number
  h?: number
  palette?: string[]
  frames?: string[]
}

// An Export press: the format, the frame shown, and the sprite as the pane holds it.
export type ExportMsg = {
  type: 'export'
  format: string
  frame?: number
  w: number
  h: number
  palette: string[]
  frames: string[]
  ms: number[]
  layers?: { name: string; frames: string[] }[] | null
}
