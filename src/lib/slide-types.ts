// All position/size fields are fractions of the slide [0, 1].
// Slide reference geometry is owned by the editor; converting to inches/EMU
// happens at import/export time only.
export type Align = 'left' | 'center' | 'right'

type BlockBase = {
  id: string
  x: number
  y: number
  w: number
  h: number
}

// A styled text fragment. Multiple runs concatenated form the block's
// `content`; paragraph breaks are encoded as "\n" inside `text`.
export type TextRun = {
  text: string
  fontSize?: number
  fontFamily?: string
  color?: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
}

export type TextBlock = BlockBase & {
  type: 'text'
  content: string
  // If present, takes precedence over block-level styling for rendering.
  // Editing the block clears this back to undefined (collapses to plain).
  runs?: TextRun[]
  fontSize?: number // points
  fontFamily?: string // e.g. "Malgun Gothic", "Arial"
  color?: string // #RRGGBB
  bold?: boolean
  italic?: boolean
  align?: Align
}

export type ImageBlock = BlockBase & {
  type: 'image'
  url: string
  alt?: string
}

// A simple line / divider extracted from <p:cxnSp>. The bounding box
// describes the line's extent; the renderer fills it with `color` so a thin
// box looks like a thin line.
export type LineBlock = BlockBase & {
  type: 'line'
  color?: string // #RRGGBB, defaults to #000000
  thickness?: number // pt, defaults to 1
}

export type TableCell = {
  id: string
  content: string
  runs?: TextRun[]
}

export type TableBlock = BlockBase & {
  type: 'table'
  rows: number
  cols: number
  // cells[row][col]; length = rows × cols. Fixed-width grid only (no merges).
  cells: TableCell[][]
  // Optional column widths and row heights as fractions of block w/h.
  // If omitted, the editor distributes equally.
  colWidths?: number[]
  rowHeights?: number[]
  fontSize?: number
  fontFamily?: string
  color?: string
  bold?: boolean
}

export type Block = TextBlock | ImageBlock | TableBlock | LineBlock

export type SlideContent = {
  blocks: Block[]
  // Slide-level background fill, #RRGGBB. Defaults to white when absent.
  background?: string
}

export type SlideData = {
  id: string
  order: number
  content: SlideContent
}

export function emptySlideContent(): SlideContent {
  return { blocks: [] }
}

// Default stacked layout used for legacy blocks that predate positioning,
// and for new blocks added via the toolbar.
export function defaultBoxForIndex(i: number) {
  const total = Math.max(1, i + 1)
  const yStep = Math.min(0.18, 0.85 / total)
  return {
    x: 0.05,
    y: Math.min(0.9 - yStep, 0.05 + i * yStep),
    w: 0.9,
    h: yStep - 0.02,
  }
}

// Accept anything from the JSON column and project it onto our typed Block
// union. Backfills positioning for legacy blocks so the editor can render
// them; on next save the migrated shape is persisted.
export function parseSlideContent(raw: unknown): SlideContent {
  if (
    !raw ||
    typeof raw !== 'object' ||
    !Array.isArray((raw as { blocks?: unknown }).blocks)
  ) {
    return emptySlideContent()
  }
  const blocks = (raw as { blocks: unknown[] }).blocks
    .map((b, i) => normalizeBlock(b, i))
    .filter((b): b is Block => b !== null)
  const bg = (raw as { background?: unknown }).background
  return {
    blocks,
    background: typeof bg === 'string' ? bg : undefined,
  }
}

function parseRuns(raw: unknown): TextRun[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: TextRun[] = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    if (typeof o.text !== 'string') continue
    out.push({
      text: o.text,
      fontSize: typeof o.fontSize === 'number' ? o.fontSize : undefined,
      fontFamily: typeof o.fontFamily === 'string' ? o.fontFamily : undefined,
      color: typeof o.color === 'string' ? o.color : undefined,
      bold: typeof o.bold === 'boolean' ? o.bold : undefined,
      italic: typeof o.italic === 'boolean' ? o.italic : undefined,
      underline: typeof o.underline === 'boolean' ? o.underline : undefined,
    })
  }
  return out.length > 0 ? out : undefined
}

function normalizeBlock(raw: unknown, idx: number): Block | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || typeof r.type !== 'string') return null

  const hasCoords =
    typeof r.x === 'number' &&
    typeof r.y === 'number' &&
    typeof r.w === 'number' &&
    typeof r.h === 'number'
  const fallback = defaultBoxForIndex(idx)
  const box = hasCoords
    ? {
        x: r.x as number,
        y: r.y as number,
        w: r.w as number,
        h: r.h as number,
      }
    : fallback

  if (r.type === 'text') {
    return {
      id: r.id,
      type: 'text',
      content: typeof r.content === 'string' ? r.content : '',
      runs: parseRuns(r.runs),
      ...box,
      fontSize: typeof r.fontSize === 'number' ? r.fontSize : undefined,
      fontFamily: typeof r.fontFamily === 'string' ? r.fontFamily : undefined,
      color: typeof r.color === 'string' ? r.color : undefined,
      bold: typeof r.bold === 'boolean' ? r.bold : undefined,
      italic: typeof r.italic === 'boolean' ? r.italic : undefined,
      align:
        r.align === 'left' || r.align === 'center' || r.align === 'right'
          ? r.align
          : undefined,
    }
  }
  if (r.type === 'image') {
    return {
      id: r.id,
      type: 'image',
      url: typeof r.url === 'string' ? r.url : '',
      alt: typeof r.alt === 'string' ? r.alt : undefined,
      ...box,
    }
  }
  if (r.type === 'line') {
    return {
      id: r.id,
      type: 'line',
      ...box,
      color: typeof r.color === 'string' ? r.color : undefined,
      thickness: typeof r.thickness === 'number' ? r.thickness : undefined,
    }
  }
  if (r.type === 'table') {
    const rows = typeof r.rows === 'number' && r.rows > 0 ? r.rows : 1
    const cols = typeof r.cols === 'number' && r.cols > 0 ? r.cols : 1
    const rawCells = Array.isArray(r.cells) ? (r.cells as unknown[][]) : []
    const cells: TableCell[][] = []
    for (let i = 0; i < rows; i++) {
      const row: TableCell[] = []
      for (let j = 0; j < cols; j++) {
        const c = rawCells[i]?.[j] as
          | { id?: unknown; content?: unknown; runs?: unknown }
          | undefined
        row.push({
          id:
            typeof c?.id === 'string'
              ? c.id
              : `${r.id}-${i}-${j}`,
          content: typeof c?.content === 'string' ? c.content : '',
          runs: parseRuns(c?.runs),
        })
      }
      cells.push(row)
    }
    return {
      id: r.id,
      type: 'table',
      rows,
      cols,
      cells,
      ...box,
      colWidths:
        Array.isArray(r.colWidths) &&
        r.colWidths.length === cols &&
        r.colWidths.every((n) => typeof n === 'number')
          ? (r.colWidths as number[])
          : undefined,
      rowHeights:
        Array.isArray(r.rowHeights) &&
        r.rowHeights.length === rows &&
        r.rowHeights.every((n) => typeof n === 'number')
          ? (r.rowHeights as number[])
          : undefined,
      fontSize: typeof r.fontSize === 'number' ? r.fontSize : undefined,
      fontFamily: typeof r.fontFamily === 'string' ? r.fontFamily : undefined,
      color: typeof r.color === 'string' ? r.color : undefined,
      bold: typeof r.bold === 'boolean' ? r.bold : undefined,
    }
  }
  return null
}

// Build a fresh table with `rows × cols` empty cells.
export function newTableBlock(
  rows: number,
  cols: number,
  box: { x: number; y: number; w: number; h: number },
): TableBlock {
  const id = crypto.randomUUID()
  const cells: TableCell[][] = []
  for (let i = 0; i < rows; i++) {
    const row: TableCell[] = []
    for (let j = 0; j < cols; j++) {
      row.push({ id: `${id}-${i}-${j}`, content: '' })
    }
    cells.push(row)
  }
  return {
    id,
    type: 'table',
    rows,
    cols,
    cells,
    fontSize: 14,
    ...box,
  }
}
