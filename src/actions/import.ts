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

function paragraphBulletPrefix(paraXml: string): string {
  // Only honor an explicit bullet in this paragraph's pPr. We don't resolve
  // master/layout inheritance, so paragraphs that inherit a bullet won't get
  // one — but we also won't add bullets where the layout said none.
  if (/<a:buNone\b/.test(paraXml)) return ''
  const buChar = paraXml.match(/<a:buChar\s+[^>]*char="([^"]*)"/)
  if (buChar && buChar[1]) {
    const ch = decodeXmlEntities(buChar[1])
    const buFont = paraXml.match(/<a:buFont\s+[^>]*typeface="([^"]+)"/)
    if (buFont && SYMBOL_FONT_RE.test(buFont[1])) return '• '
    // A single ASCII letter as a bullet is almost always a symbol-font char
    // that's been mis-decoded; promote to a normal bullet.
    if (/^[A-Za-z]$/.test(ch)) return '• '
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

async function readImageEmbeds(
  zip: JSZip,
  slidePath: string,
): Promise<Map<string, string>> {
  // Returns: rId -> data URL.
  const m = slidePath.match(/^ppt\/slides\/(slide\d+)\.xml$/)
  if (!m) return new Map()
  const relsPath = `ppt/slides/_rels/${m[1]}.xml.rels`
  const relsXml = await zip.file(relsPath)?.async('string')
  if (!relsXml) return new Map()

  const out = new Map<string, string>()
  const relRe =
    /<Relationship\s+[^>]*Id="([^"]+)"[^>]*Type="[^"]*\/image"[^>]*Target="([^"]+)"/g
  for (const rel of relsXml.matchAll(relRe)) {
    const rId = rel[1]
    const target = rel[2].replace(/^\.\.\//, 'ppt/')
    const file = zip.file(target)
    if (!file) continue
    const ext = target.split('.').pop()?.toLowerCase() ?? 'png'
    const mime =
      ext === 'jpg' || ext === 'jpeg'
        ? 'image/jpeg'
        : ext === 'gif'
          ? 'image/gif'
          : ext === 'svg'
            ? 'image/svg+xml'
            : 'image/png'
    const buf = await file.async('base64')
    out.set(rId, `data:${mime};base64,${buf}`)
  }
  return out
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
): Promise<Block[]> {
  const blocks: Block[] = []

  // Walk text shapes (<p:sp>) in document order.
  const shapeRe = /<p:sp\b[^>]*>([\s\S]*?)<\/p:sp>/g
  let shapeIdx = 0
  for (const m of slideXml.matchAll(shapeRe)) {
    const shapeXml = m[1]
    const text = extractParagraphsText(shapeXml)
    if (!text.trim()) {
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

function extractLineBlock(
  cxnXml: string,
  size: SlideSize,
): LineBlock | null {
  const xfrm = parseXfrm(cxnXml)
  if (!xfrm) return null
  // Line color: first <a:solidFill><a:srgbClr> inside <a:ln>.
  const colorM = cxnXml.match(
    /<a:ln\b[^>]*>[\s\S]*?<a:solidFill>\s*<a:srgbClr\s+val="([0-9A-Fa-f]{6})"/,
  )
  // Line thickness: <a:ln w="..."> in EMU; 1pt = 12700 EMU.
  const wM = cxnXml.match(/<a:ln\b[^>]*\sw="(\d+)"/)
  return {
    id: randomUUID(),
    type: 'line',
    x: clamp01(xfrm.x / size.cx),
    y: clamp01(xfrm.y / size.cy),
    w: clamp01(xfrm.cx / size.cx),
    h: clamp01(xfrm.cy / size.cy),
    ...(colorM ? { color: '#' + colorM[1].toUpperCase() } : {}),
    ...(wM ? { thickness: Number(wM[1]) / 12700 } : {}),
  }
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

  const slides: SlideContent[] = []
  for (const slidePath of slidePaths) {
    const xml = await zip.file(slidePath)!.async('string')
    const embeds = await readImageEmbeds(zip, slidePath)
    const blocks = await parseSlideXml(xml, size, embeds)
    const background = extractSlideBackground(xml)
    slides.push({ blocks, ...(background ? { background } : {}) })
  }
  return slides
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
