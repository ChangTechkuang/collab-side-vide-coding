'use server'

import { redirect } from 'next/navigation'
import { Prisma } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import JSZip from 'jszip'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/current-user'
import type {
  Align,
  Block,
  ImageBlock,
  LineBlock,
  SlideContent,
  TableBlock,
  TableCell,
  TextBlock,
  TextRun,
} from '@/lib/slide-types'

const MAX_PPTX_BYTES = 25_000_000

// PPTX widescreen default: 13.333 in × 7.5 in.
const DEFAULT_SLIDE_CX = 12_192_000
const DEFAULT_SLIDE_CY = 6_858_000

type Xfrm = { x: number; y: number; cx: number; cy: number }
type SlideSize = { cx: number; cy: number }

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
}

async function readSlideSize(zip: JSZip): Promise<SlideSize> {
  const xml = await zip.file('ppt/presentation.xml')?.async('string')
  if (!xml) return { cx: DEFAULT_SLIDE_CX, cy: DEFAULT_SLIDE_CY }
  const m = xml.match(/<p:sldSz\s+[^>]*cx="(\d+)"[^>]*cy="(\d+)"/)
  if (!m) return { cx: DEFAULT_SLIDE_CX, cy: DEFAULT_SLIDE_CY }
  return { cx: Number(m[1]), cy: Number(m[2]) }
}

function parseXfrm(xml: string): Xfrm | undefined {
  const off = xml.match(/<a:off\s+[^>]*x="(-?\d+)"[^>]*y="(-?\d+)"/)
  const ext = xml.match(/<a:ext\s+[^>]*cx="(\d+)"[^>]*cy="(\d+)"/)
  if (!off || !ext) return undefined
  return {
    x: Number(off[1]),
    y: Number(off[2]),
    cx: Number(ext[1]),
    cy: Number(ext[2]),
  }
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0
}

function xfrmToBox(xfrm: Xfrm | undefined, size: SlideSize, fallback: Xfrm) {
  const x = xfrm ?? fallback
  return {
    x: clamp01(x.x / size.cx),
    y: clamp01(x.y / size.cy),
    w: clamp01(x.cx / size.cx),
    h: clamp01(x.cy / size.cy),
  }
}

// Symbol fonts whose bullet chars don't render as the intended glyph in
// generic text — substitute with a normal Unicode bullet.
const SYMBOL_FONT_RE = /Wingdings|Symbol|Webdings|Marlett/i

// Approximate Wingdings/Symbol → Unicode bullet mapping. PPTX often uses
// ASCII letters paired with a symbol font for bullet glyphs; without the
// font, those render as plain letters. Substitute with the closest Unicode
// shape so the bullet looks right regardless of installed fonts.
const SYMBOL_BULLET_MAP: Record<string, string> = {
  l: '◆', // Wingdings level-1 bullet (commonly diamond in Korean templates)
  m: '◆',
  n: '■',
  o: '□',
  p: '★',
  q: '◇',
  s: '▲',
  t: '▼',
  u: '◆',
  v: '◆',
  w: '◇',
  '§': '◆',
}

function paragraphBulletPrefix(paraXml: string): string {
  // Only honor an explicit bullet in this paragraph's pPr. We don't resolve
  // master/layout inheritance, so paragraphs that inherit a bullet won't get
  // one — but we also won't add bullets where the layout said none.
  if (/<a:buNone\b/.test(paraXml)) return ''
  const buChar = paraXml.match(/<a:buChar\s+[^>]*char="([^"]*)"/)
  if (buChar && buChar[1]) {
    const ch = decodeXmlEntities(buChar[1])
    const buFont = paraXml.match(/<a:buFont\s+[^>]*typeface="([^"]+)"/)
    const isSymbolFont = !!(buFont && SYMBOL_FONT_RE.test(buFont[1]))
    if (isSymbolFont || /^[A-Za-z]$/.test(ch)) {
      return (SYMBOL_BULLET_MAP[ch] ?? '◆') + ' '
    }
    // Real Unicode bullet character — pass through.
    return ch + ' '
  }
  if (/<a:buAutoNum\b/.test(paraXml)) return '• '
  return ''
}

function extractParagraphsText(shapeXml: string): string {
  const lines: string[] = []
  for (const paraM of shapeXml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)) {
    const paraXml = paraM[1]
    let line = ''
    for (const tM of paraXml.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g)) {
      line += decodeXmlEntities(tM[1])
    }
    if (line.trim()) {
      line = paragraphBulletPrefix(paraXml) + line
    }
    lines.push(line)
  }
  // Trim trailing/leading empty paragraphs but preserve interior blank lines.
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop()
  }
  while (lines.length > 0 && lines[0].trim() === '') {
    lines.shift()
  }
  return lines.join('\n')
}

// <a:rPr> attribute string + inner XML → run-level style.
function parseRunPropsFromXml(
  rPrAttrs: string,
  rPrInner: string,
): Omit<TextRun, 'text'> {
  const out: Omit<TextRun, 'text'> = {}
  const sz = rPrAttrs.match(/\bsz="(\d+)"/)
  if (sz) out.fontSize = Number(sz[1]) / 100
  if (/\bb="1"/.test(rPrAttrs)) out.bold = true
  if (/\bi="1"/.test(rPrAttrs)) out.italic = true
  if (/\bu="(?!none\b)/.test(rPrAttrs)) out.underline = true
  const colorM = rPrInner.match(/<a:srgbClr\s+val="([0-9A-Fa-f]{6})"/)
  if (colorM) out.color = '#' + colorM[1].toUpperCase()
  const ea = rPrInner.match(/<a:ea\s+[^>]*typeface="([^"]+)"/)?.[1]
  const latin = rPrInner.match(/<a:latin\s+[^>]*typeface="([^"]+)"/)?.[1]
  const pick = (face?: string) =>
    face && !face.startsWith('+') ? face : undefined
  const fam = pick(ea) ?? pick(latin)
  if (fam) out.fontFamily = fam
  return out
}

// Build TextRun[] for one paragraph. <a:r> are styled runs, <a:br/> is a
// hard line break.
function paragraphRuns(paraXml: string): TextRun[] {
  const runs: TextRun[] = []
  const tokenRe = /<a:r\b[^>]*>([\s\S]*?)<\/a:r>|<a:br\s*\/?>/g
  for (const m of paraXml.matchAll(tokenRe)) {
    if (m[0].startsWith('<a:br')) {
      if (runs.length > 0) runs[runs.length - 1].text += '\n'
      else runs.push({ text: '\n' })
      continue
    }
    const inner = m[1] ?? ''
    let text = ''
    for (const t of inner.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g)) {
      text += decodeXmlEntities(t[1])
    }
    if (!text) continue
    const rPrM = inner.match(
      /<a:rPr\b([^>]*)>([\s\S]*?)<\/a:rPr>|<a:rPr\b([^>]*)\/>/,
    )
    const attrs = rPrM ? (rPrM[1] ?? rPrM[3] ?? '') : ''
    const innerRPr = rPrM ? (rPrM[2] ?? '') : ''
    runs.push({ text, ...parseRunPropsFromXml(attrs, innerRPr) })
  }
  return runs
}

// Walk all <a:p> in a shape body, joining paragraphs with "\n" appended to
// the previous run.
function shapeRuns(shapeXml: string): TextRun[] {
  const allRuns: TextRun[] = []
  let firstParagraph = true
  for (const paraM of shapeXml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)) {
    const paraXml = paraM[1]
    const runs = paragraphRuns(paraXml)
    const concat = runs.map((r) => r.text).join('')
    if (!concat.trim() && firstParagraph) continue
    if (!firstParagraph) {
      if (allRuns.length > 0) allRuns[allRuns.length - 1].text += '\n'
      else allRuns.push({ text: '\n' })
    }
    const prefix = paragraphBulletPrefix(paraXml)
    if (prefix && runs.length > 0) {
      allRuns.push({ ...runs[0], text: prefix })
    }
    for (const r of runs) allRuns.push(r)
    firstParagraph = false
  }
  while (
    allRuns.length > 0 &&
    allRuns[allRuns.length - 1].text.trim() === ''
  ) {
    allRuns.pop()
  }
  return allRuns
}

function extractFirstAlignment(shapeXml: string): Align | undefined {
  const m = shapeXml.match(/<a:pPr\b[^>]*\salgn="([a-z]+)"/)
  if (!m) return undefined
  if (m[1] === 'l') return 'left'
  if (m[1] === 'ctr') return 'center'
  if (m[1] === 'r') return 'right'
  return undefined
}

function extractFirstRunStyle(shapeXml: string): {
  fontSize?: number
  fontFamily?: string
  bold?: boolean
  italic?: boolean
  color?: string
} {
  const out: {
    fontSize?: number
    fontFamily?: string
    bold?: boolean
    italic?: boolean
    color?: string
  } = {}
  // Find first <a:r> ... </a:r> that contains an <a:t>
  const runRe = /<a:r\b[^>]*>([\s\S]*?)<\/a:r>/g
  for (const m of shapeXml.matchAll(runRe)) {
    if (!/<a:t\b/.test(m[1])) continue
    const rPrM = m[1].match(/<a:rPr\b([^>]*)>([\s\S]*?)<\/a:rPr>|<a:rPr\b([^>]*)\/>/)
    if (rPrM) {
      const attrs = rPrM[1] ?? rPrM[3] ?? ''
      const inner = rPrM[2] ?? ''
      const sz = attrs.match(/\bsz="(\d+)"/)
      if (sz) out.fontSize = Number(sz[1]) / 100
      if (/\bb="1"/.test(attrs)) out.bold = true
      if (/\bi="1"/.test(attrs)) out.italic = true
      const colorM = inner.match(/<a:srgbClr\s+val="([0-9A-Fa-f]{6})"/)
      if (colorM) out.color = '#' + colorM[1].toUpperCase()
      // Prefer East Asian face when present (Korean/Japanese/Chinese), then
      // Latin. Skip theme-reference placeholders like "+mn-ea" / "+mj-lt".
      const ea = inner.match(/<a:ea\s+[^>]*typeface="([^"]+)"/)?.[1]
      const latin = inner.match(/<a:latin\s+[^>]*typeface="([^"]+)"/)?.[1]
      const pick = (face?: string) =>
        face && !face.startsWith('+') ? face : undefined
      out.fontFamily = pick(ea) ?? pick(latin)
    }
    break
  }
  return out
}

// Generic rels-file reader that resolves image targets relative to whichever
// XML owns the rels (slide, slideLayout, slideMaster, etc.). Returns a map
// from rId → data URL.
async function readImageEmbedsForXml(
  zip: JSZip,
  xmlPath: string,
): Promise<Map<string, string>> {
  // xmlPath: "ppt/slides/slide1.xml"  →  rels: "ppt/slides/_rels/slide1.xml.rels"
  // xmlPath: "ppt/slideLayouts/slideLayout1.xml" → ppt/slideLayouts/_rels/slideLayout1.xml.rels
  const dirAndFile = xmlPath.match(/^(.*\/)([^/]+\.xml)$/)
  if (!dirAndFile) return new Map()
  const [, dir, file] = dirAndFile
  const relsPath = `${dir}_rels/${file}.rels`
  const relsXml = await zip.file(relsPath)?.async('string')
  if (!relsXml) return new Map()

  const out = new Map<string, string>()
  const relRe =
    /<Relationship\s+[^>]*Id="([^"]+)"[^>]*Type="[^"]*\/image"[^>]*Target="([^"]+)"/g
  for (const rel of relsXml.matchAll(relRe)) {
    const target = rel[2]
    // Resolve relative to the rels directory. "../media/img.png" rooted at
    // ppt/slides/_rels/ → ppt/media/img.png. Targets without "../" are
    // relative to the dir owning the XML.
    let resolved: string
    if (target.startsWith('../')) {
      const parent = dir.replace(/[^/]+\/$/, '') // ppt/slides/ → ppt/
      resolved = parent + target.slice(3)
    } else {
      resolved = dir + target
    }
    const f = zip.file(resolved)
    if (!f) continue
    const ext = resolved.split('.').pop()?.toLowerCase() ?? 'png'
    const mime =
      ext === 'jpg' || ext === 'jpeg'
        ? 'image/jpeg'
        : ext === 'gif'
          ? 'image/gif'
          : ext === 'svg'
            ? 'image/svg+xml'
            : 'image/png'
    const buf = await f.async('base64')
    out.set(rel[1], `data:${mime};base64,${buf}`)
  }
  return out
}

// Resolve the slideLayout XML path referenced by a slide's rels.
async function findLayoutPath(
  zip: JSZip,
  slideXmlPath: string,
): Promise<string | null> {
  const dirAndFile = slideXmlPath.match(/^(.*\/)([^/]+\.xml)$/)
  if (!dirAndFile) return null
  const [, dir, file] = dirAndFile
  const relsXml = await zip.file(`${dir}_rels/${file}.rels`)?.async('string')
  if (!relsXml) return null
  const m = relsXml.match(
    /<Relationship\s+[^>]*Type="[^"]*\/slideLayout"[^>]*Target="([^"]+)"/,
  )
  if (!m) return null
  const target = m[1]
  if (target.startsWith('../')) {
    return dir.replace(/[^/]+\/$/, '') + target.slice(3)
  }
  return dir + target
}

// Resolve the slideMaster XML path referenced by a layout's rels.
async function findMasterPath(
  zip: JSZip,
  layoutXmlPath: string,
): Promise<string | null> {
  const dirAndFile = layoutXmlPath.match(/^(.*\/)([^/]+\.xml)$/)
  if (!dirAndFile) return null
  const [, dir, file] = dirAndFile
  const relsXml = await zip.file(`${dir}_rels/${file}.rels`)?.async('string')
  if (!relsXml) return null
  const m = relsXml.match(
    /<Relationship\s+[^>]*Type="[^"]*\/slideMaster"[^>]*Target="([^"]+)"/,
  )
  if (!m) return null
  const target = m[1]
  if (target.startsWith('../')) {
    return dir.replace(/[^/]+\/$/, '') + target.slice(3)
  }
  return dir + target
}

// Build a single TableBlock from a <p:graphicFrame> containing <a:tbl>.
// Cells are stored in a fixed rows × cols grid — merges are flattened so
// the slave cells become empty strings.
function extractTableBlock(
  graphicFrameXml: string,
  size: SlideSize,
): TableBlock | null {
  const xfrm = parseXfrm(graphicFrameXml)
  if (!xfrm) return null

  const tblM = graphicFrameXml.match(/<a:tbl\b[\s\S]*?<\/a:tbl>/)
  if (!tblM) return null

  const tblXml = tblM[0]

  const colWidthsEmu: number[] = []
  for (const m of tblXml.matchAll(/<a:gridCol\s+[^>]*w="(\d+)"/g)) {
    colWidthsEmu.push(Number(m[1]))
  }
  const cols = colWidthsEmu.length
  if (cols === 0) return null
  const totalColW = colWidthsEmu.reduce((a, b) => a + b, 0) || xfrm.cx

  const trMatches = Array.from(
    tblXml.matchAll(/<a:tr\b([^>]*)>([\s\S]*?)<\/a:tr>/g),
  )
  const rows = trMatches.length
  if (rows === 0) return null

  const rowHeightsEmu: number[] = trMatches.map((m) => {
    const h = m[1].match(/\sh="(\d+)"/)
    return h ? Number(h[1]) : Math.round(xfrm.cy / Math.max(1, rows))
  })
  const totalRowH = rowHeightsEmu.reduce((a, b) => a + b, 0) || xfrm.cy

  // Pull style from the first non-empty cell so the table inherits a
  // reasonable font size / family.
  let inheritedStyle:
    | ReturnType<typeof extractFirstRunStyle>
    | undefined

  const cells: TableCell[][] = []
  for (let i = 0; i < rows; i++) {
    const rowXml = trMatches[i][2]
    const tcMatches = Array.from(
      rowXml.matchAll(/<a:tc\b([^>]*)>([\s\S]*?)<\/a:tc>/g),
    )
    const row: TableCell[] = []
    for (let j = 0; j < cols; j++) {
      const tc = tcMatches[j]
      const tcAttrs = tc?.[1] ?? ''
      const tcInner = tc?.[2] ?? ''
      const isMerged = /\b[hv]Merge="1"/.test(tcAttrs)
      const text = isMerged ? '' : extractParagraphsText(tcInner)
      if (!inheritedStyle && text.trim()) {
        inheritedStyle = extractFirstRunStyle(tcInner)
      }
      const cellRuns = isMerged ? [] : shapeRuns(tcInner)
      row.push({
        id: randomUUID(),
        content: text,
        ...(cellRuns.length > 0 ? { runs: cellRuns } : {}),
      })
    }
    cells.push(row)
  }

  return {
    id: randomUUID(),
    type: 'table',
    rows,
    cols,
    cells,
    x: clamp01(xfrm.x / size.cx),
    y: clamp01(xfrm.y / size.cy),
    w: clamp01(xfrm.cx / size.cx),
    h: clamp01(xfrm.cy / size.cy),
    colWidths: colWidthsEmu.map((e) => e / totalColW),
    rowHeights: rowHeightsEmu.map((e) => e / totalRowH),
    fontSize: inheritedStyle?.fontSize,
    fontFamily: inheritedStyle?.fontFamily,
    color: inheritedStyle?.color,
    bold: inheritedStyle?.bold,
  }
}

async function parseSlideXml(
  slideXml: string,
  size: SlideSize,
  embeds: Map<string, string>,
  // When true, treat this XML as a layout/master template — skip text
  // shapes that are placeholders (<p:ph>), since those are content-prompts
  // (e.g. "Click to add title") that the actual slide overrides.
  isTemplate = false,
): Promise<Block[]> {
  const blocks: Block[] = []

  // Walk text shapes (<p:sp>) in document order.
  const shapeRe = /<p:sp\b[^>]*>([\s\S]*?)<\/p:sp>/g
  let shapeIdx = 0
  for (const m of slideXml.matchAll(shapeRe)) {
    const shapeXml = m[1]
    if (isTemplate && /<p:ph\b/.test(shapeXml)) {
      shapeIdx++
      continue
    }
    const text = extractParagraphsText(shapeXml)
    if (!text.trim()) {
      // Shapes without text can still be decorative — divider strips,
      // accent rectangles, etc. If they have a fill or outline color,
      // extract as a LineBlock at their bounding box.
      const lb = extractEmptyShapeAsLine(shapeXml, size)
      if (lb) blocks.push(lb)
      shapeIdx++
      continue
    }
    const xfrm = parseXfrm(shapeXml)
    const fallback: Xfrm = {
      x: Math.round(size.cx * 0.05),
      y: Math.round(size.cy * (0.05 + shapeIdx * 0.18)),
      cx: Math.round(size.cx * 0.9),
      cy: Math.round(size.cy * 0.16),
    }
    const box = xfrmToBox(xfrm, size, fallback)
    const style = extractFirstRunStyle(shapeXml)
    const align = extractFirstAlignment(shapeXml)
    const runs = shapeRuns(shapeXml)
    const block: TextBlock = {
      id: randomUUID(),
      type: 'text',
      content: text,
      ...box,
      ...style,
      ...(align ? { align } : {}),
      ...(runs.length > 0 ? { runs } : {}),
    }
    blocks.push(block)
    shapeIdx++
  }

  // Walk picture shapes (<p:pic>).
  const picRe = /<p:pic\b[^>]*>([\s\S]*?)<\/p:pic>/g
  for (const m of slideXml.matchAll(picRe)) {
    const picXml = m[1]
    const xfrm = parseXfrm(picXml)
    const fallback: Xfrm = {
      x: Math.round(size.cx * 0.1),
      y: Math.round(size.cy * 0.1),
      cx: Math.round(size.cx * 0.4),
      cy: Math.round(size.cy * 0.4),
    }
    const box = xfrmToBox(xfrm, size, fallback)
    const embedM = picXml.match(/<a:blip\s+[^>]*r:embed="([^"]+)"/)
    const url = embedM ? (embeds.get(embedM[1]) ?? '') : ''
    const block: ImageBlock = {
      id: randomUUID(),
      type: 'image',
      url,
      ...box,
    }
    blocks.push(block)
  }

  // Walk table shapes (<p:graphicFrame> containing <a:tbl>). Each table
  // becomes a single TableBlock with its own rows × cols grid.
  for (const m of slideXml.matchAll(
    /<p:graphicFrame\b[^>]*>([\s\S]*?)<\/p:graphicFrame>/g,
  )) {
    const tb = extractTableBlock(m[1], size)
    if (tb) blocks.push(tb)
  }

  // Walk connector shapes (<p:cxnSp>) — these are typically lines and
  // dividers. The bounding box becomes the line's extent.
  for (const m of slideXml.matchAll(
    /<p:cxnSp\b[^>]*>([\s\S]*?)<\/p:cxnSp>/g,
  )) {
    const lb = extractLineBlock(m[1], size)
    if (lb) blocks.push(lb)
  }

  return blocks
}

// Theme color references (<a:schemeClr>) point at the master's color theme.
// We don't resolve themes; this is the visible default for unresolved lines.
const SCHEME_COLOR_FALLBACK = '#5B6770'
const DEFAULT_LINE_THICKNESS_EMU = 12700 // 1pt

function extractLineBlock(
  cxnXml: string,
  size: SlideSize,
): LineBlock | null {
  const xfrm = parseXfrm(cxnXml)
  if (!xfrm) return null

  // Line color from <a:ln><a:solidFill><a:srgbClr>; if missing, check
  // <a:schemeClr> and substitute a generic dark gray.
  const rgb = cxnXml.match(
    /<a:ln\b[^>]*>[\s\S]*?<a:solidFill>\s*<a:srgbClr\s+val="([0-9A-Fa-f]{6})"/,
  )?.[1]
  const hasSchemeColor =
    !rgb &&
    /<a:ln\b[^>]*>[\s\S]*?<a:solidFill>\s*<a:schemeClr/.test(cxnXml)
  const color = rgb
    ? '#' + rgb.toUpperCase()
    : hasSchemeColor
      ? SCHEME_COLOR_FALLBACK
      : undefined

  // Line thickness: <a:ln w="..."> in EMU.
  const wEmu = Number(
    cxnXml.match(/<a:ln\b[^>]*\sw="(\d+)"/)?.[1] ?? DEFAULT_LINE_THICKNESS_EMU,
  )

  // PPTX "logical lines" often have cy=0 (or cx=0) — the line is drawn
  // diagonally inside the bounding box. For our solid-fill render we need
  // a non-zero box; inflate to the line thickness on the collapsed axis.
  const cx = xfrm.cx === 0 ? wEmu : xfrm.cx
  const cy = xfrm.cy === 0 ? wEmu : xfrm.cy

  return {
    id: randomUUID(),
    type: 'line',
    x: clamp01(xfrm.x / size.cx),
    y: clamp01(xfrm.y / size.cy),
    w: clamp01(cx / size.cx),
    h: clamp01(cy / size.cy),
    ...(color ? { color } : {}),
    thickness: wEmu / 12700,
  }
}

// Many decks build divider lines and accent strips with empty <p:sp>
// rectangles that have a solid fill or outline. These would otherwise be
// filtered out by our "no text → skip" rule. Extract them as LineBlocks at
// their bounding box. Capped at 50% of slide area to avoid sucking in
// full-page background fills.
function extractEmptyShapeAsLine(
  shapeXml: string,
  size: SlideSize,
): LineBlock | null {
  const xfrm = parseXfrm(shapeXml)
  if (!xfrm) return null

  // Skip huge shapes — likely background fills, not decorations.
  // Use max(cx*cy, 1) to avoid divide-by-zero for collapsed (line-like) shapes.
  const areaFrac = (xfrm.cx * xfrm.cy) / (size.cx * size.cy)
  if (areaFrac > 0.5) return null

  const isLineGeom =
    /<a:prstGeom\s+[^>]*prst="(line|straightConnector1|straightConnector2|straightConnector3)"/.test(
      shapeXml,
    )

  // Resolve fill / outline color, preferring explicit srgb. Fall back to a
  // generic dark gray when only a theme reference is present.
  const fillRgb = shapeXml.match(
    /<p:spPr\b[^>]*>[\s\S]*?<a:solidFill>\s*<a:srgbClr\s+val="([0-9A-Fa-f]{6})"/,
  )?.[1]
  const lnRgb = shapeXml.match(
    /<a:ln\b[^>]*>[\s\S]*?<a:solidFill>\s*<a:srgbClr\s+val="([0-9A-Fa-f]{6})"/,
  )?.[1]
  const hasFillScheme =
    !fillRgb &&
    /<p:spPr\b[^>]*>[\s\S]*?<a:solidFill>\s*<a:schemeClr/.test(shapeXml)
  const hasLnScheme =
    !lnRgb &&
    /<a:ln\b[^>]*>[\s\S]*?<a:solidFill>\s*<a:schemeClr/.test(shapeXml)

  const rgb = fillRgb ?? lnRgb
  const usesScheme = hasFillScheme || hasLnScheme
  if (!rgb && !usesScheme && !isLineGeom) return null

  const color = rgb
    ? '#' + rgb.toUpperCase()
    : usesScheme
      ? SCHEME_COLOR_FALLBACK
      : SCHEME_COLOR_FALLBACK

  const wEmu = Number(
    shapeXml.match(/<a:ln\b[^>]*\sw="(\d+)"/)?.[1] ?? DEFAULT_LINE_THICKNESS_EMU,
  )
  // Inflate collapsed axis so a zero-height/width "logical line" still has
  // a visible rendered box.
  const cx = xfrm.cx === 0 ? wEmu : xfrm.cx
  const cy = xfrm.cy === 0 ? wEmu : xfrm.cy

  return {
    id: randomUUID(),
    type: 'line',
    x: clamp01(xfrm.x / size.cx),
    y: clamp01(xfrm.y / size.cy),
    w: clamp01(cx / size.cx),
    h: clamp01(cy / size.cy),
    color,
    thickness: wEmu / 12700,
  }
}

// Parse a slideLayout or slideMaster XML, returning its decoration blocks
// (logos, divider lines, footer text shapes). Placeholder shapes are
// filtered out — they're prompts that the actual slide overrides.
async function parseTemplateBlocks(
  zip: JSZip,
  templatePath: string,
  size: SlideSize,
): Promise<Block[]> {
  const xml = await zip.file(templatePath)?.async('string')
  if (!xml) return []
  const embeds = await readImageEmbedsForXml(zip, templatePath)
  return parseSlideXml(xml, size, embeds, /* isTemplate */ true)
}

async function parsePptxWithSize(
  zip: JSZip,
  size: SlideSize,
): Promise<SlideContent[]> {
  const slidePaths = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => {
      const na = Number(a.match(/slide(\d+)\.xml$/)![1])
      const nb = Number(b.match(/slide(\d+)\.xml$/)![1])
      return na - nb
    })

  if (slidePaths.length === 0) {
    throw new Error('No slides found in .pptx (is the file valid?)')
  }

  // Cache layout + master parsing — every slide in a deck typically shares
  // the same layout/master, so this avoids repeated XML reads.
  const templateCache = new Map<string, Block[]>()
  async function getTemplateBlocks(path: string): Promise<Block[]> {
    const cached = templateCache.get(path)
    if (cached) return cached
    const blocks = await parseTemplateBlocks(zip, path, size)
    templateCache.set(path, blocks)
    return blocks
  }

  const slides: SlideContent[] = []
  for (const slidePath of slidePaths) {
    const xml = await zip.file(slidePath)!.async('string')
    const embeds = await readImageEmbedsForXml(zip, slidePath)
    const slideBlocks = await parseSlideXml(xml, size, embeds, false)

    // Walk layout + master. Master goes at the bottom of the z-order
    // (rendered first), then layout, then slide on top.
    const layoutPath = await findLayoutPath(zip, slidePath)
    const masterPath = layoutPath ? await findMasterPath(zip, layoutPath) : null
    const masterBlocks = masterPath ? await getTemplateBlocks(masterPath) : []
    const layoutBlocks = layoutPath ? await getTemplateBlocks(layoutPath) : []

    const blocks = dropTableBackdropLines([
      ...masterBlocks,
      ...layoutBlocks,
      ...slideBlocks,
    ])
    const background = extractSlideBackground(xml)
    slides.push({ blocks, ...(background ? { background } : {}) })
  }
  return slides
}

// True when `inner` sits inside `outer` (with a small float-tolerance
// epsilon). Used to decide whether a decorative shape is acting as the
// backdrop for another block.
function boxContains(
  outer: { x: number; y: number; w: number; h: number },
  inner: { x: number; y: number; w: number; h: number },
): boolean {
  const eps = 0.005
  return (
    inner.x + eps >= outer.x &&
    inner.y + eps >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w + eps &&
    inner.y + inner.h <= outer.y + outer.h + eps
  )
}

// Drop fallback-gray <p:sp> rectangles that sit inside a TableBlock's box.
// PPTX decks routinely place a master/layout rectangle behind a content
// region whose fill is a <a:schemeClr> (theme accent / table-style). We
// can't resolve theme colors, so we paint those rects in SCHEME_COLOR_FALLBACK
// — which then bleeds through the table's transparent cells as a gray slab.
// Suppressing them lets the table render clean against the slide background;
// real (srgb) accent rects are untouched.
function dropTableBackdropLines(blocks: Block[]): Block[] {
  const tables = blocks.filter((b): b is TableBlock => b.type === 'table')
  if (tables.length === 0) return blocks
  return blocks.filter((b) => {
    if (b.type !== 'line') return true
    if (b.color !== SCHEME_COLOR_FALLBACK) return true
    return !tables.some((t) => boxContains(t, b))
  })
}

// Slide-level background fill from <p:bg><p:bgPr><a:solidFill><a:srgbClr>.
// We don't resolve master/layout backgrounds — those return undefined and
// the editor falls back to white.
function extractSlideBackground(slideXml: string): string | undefined {
  const m = slideXml.match(
    /<p:bg\b[^>]*>[\s\S]*?<a:solidFill>\s*<a:srgbClr\s+val="([0-9A-Fa-f]{6})"/,
  )
  if (!m) return undefined
  return '#' + m[1].toUpperCase()
}

export async function importPptx(formData: FormData) {
  const user = await getCurrentUser()

  const file = formData.get('file')
  if (!(file instanceof File) || file.size === 0) {
    throw new Error('No file uploaded')
  }
  if (file.size > MAX_PPTX_BYTES) {
    throw new Error(`File too large (max ${MAX_PPTX_BYTES} bytes)`)
  }
  if (!/\.pptx$/i.test(file.name)) {
    throw new Error('Expected a .pptx file')
  }

  const buffer = Buffer.from(await file.arrayBuffer())
  const zip = await JSZip.loadAsync(buffer)
  const size = await readSlideSize(zip)
  const slideContents = await parsePptxWithSize(zip, size)

  const fallbackTitle = file.name.replace(/\.pptx$/i, '')
  const title =
    String(formData.get('title') ?? '').trim() ||
    fallbackTitle ||
    'Imported deck'

  const project = await db.project.create({
    data: {
      title,
      ownerId: user.id,
      slideWidthIn: size.cx / 914400,
      slideHeightIn: size.cy / 914400,
      members: { create: { userId: user.id, role: 'OWNER' } },
      slides: {
        create: slideContents.map((content, idx) => ({
          order: idx,
          // JSON round-trip strips `undefined` fields. Prisma's JSON column
          // serializer rejects undefined values in nested data.
          content: JSON.parse(
            JSON.stringify(content),
          ) as Prisma.InputJsonValue,
        })),
      },
    },
  })

  redirect(`/projects/${project.id}`)
}
