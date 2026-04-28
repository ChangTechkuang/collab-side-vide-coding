// Validate the new positioned-block parser against a real .pptx.
// Reports per-slide block count, position spread, font props, and image count.
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import JSZip from 'jszip'

const PPTX_PATH =
  process.argv[2] ?? 'C:\\Users\\DELL\\Downloads\\sample.pptx'

type Align = 'left' | 'center' | 'right'
type TextBlock = {
  id: string
  type: 'text'
  content: string
  x: number
  y: number
  w: number
  h: number
  fontSize?: number
  color?: string
  bold?: boolean
  italic?: boolean
  align?: Align
}
type ImageBlock = {
  id: string
  type: 'image'
  url: string
  x: number
  y: number
  w: number
  h: number
}
type Block = TextBlock | ImageBlock

const DEFAULT_SLIDE_CX = 12_192_000
const DEFAULT_SLIDE_CY = 6_858_000

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
}

async function readSlideSize(zip: JSZip) {
  const xml = await zip.file('ppt/presentation.xml')?.async('string')
  if (!xml) return { cx: DEFAULT_SLIDE_CX, cy: DEFAULT_SLIDE_CY }
  const m = xml.match(/<p:sldSz\s+[^>]*cx="(\d+)"[^>]*cy="(\d+)"/)
  if (!m) return { cx: DEFAULT_SLIDE_CX, cy: DEFAULT_SLIDE_CY }
  return { cx: Number(m[1]), cy: Number(m[2]) }
}

function parseXfrm(xml: string) {
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

function clamp01(n: number) {
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0
}

const SYMBOL_FONT_RE = /Wingdings|Symbol|Webdings|Marlett/i

function bulletPrefix(paraXml: string): string {
  if (/<a:buNone\b/.test(paraXml)) return ''
  const buChar = paraXml.match(/<a:buChar\s+[^>]*char="([^"]*)"/)
  if (buChar && buChar[1]) {
    const ch = decodeXmlEntities(buChar[1])
    const buFont = paraXml.match(/<a:buFont\s+[^>]*typeface="([^"]+)"/)
    if (buFont && SYMBOL_FONT_RE.test(buFont[1])) return '• '
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
    if (line.trim()) line = bulletPrefix(paraXml) + line
    lines.push(line)
  }
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
  while (lines.length > 0 && lines[0].trim() === '') lines.shift()
  return lines.join('\n')
}

function extractTableBlocks(
  graphicFrameXml: string,
  size: { cx: number; cy: number },
): Block[] {
  const xfrm = parseXfrm(graphicFrameXml)
  if (!xfrm) return []
  const tblM = graphicFrameXml.match(/<a:tbl\b[\s\S]*?<\/a:tbl>/)
  if (!tblM) return []
  const tblXml = tblM[0]
  const colWidths: number[] = []
  for (const m of tblXml.matchAll(/<a:gridCol\s+[^>]*w="(\d+)"/g)) {
    colWidths.push(Number(m[1]))
  }
  if (colWidths.length === 0) return []
  const totalColW = colWidths.reduce((a, b) => a + b, 0) || xfrm.cx
  const rows: Array<{ heightEmu: number; xml: string }> = []
  for (const trM of tblXml.matchAll(
    /<a:tr\b([^>]*)>([\s\S]*?)<\/a:tr>/g,
  )) {
    const hM = trM[1].match(/\sh="(\d+)"/)
    rows.push({
      heightEmu: hM ? Number(hM[1]) : Math.round(xfrm.cy / 4),
      xml: trM[2],
    })
  }
  if (rows.length === 0) return []
  const totalRowH = rows.reduce((a, r) => a + r.heightEmu, 0) || xfrm.cy
  const blocks: Block[] = []
  let rowOffset = 0
  for (const row of rows) {
    let colIdx = 0
    let colOffset = 0
    for (const tcM of row.xml.matchAll(/<a:tc\b([^>]*)>([\s\S]*?)<\/a:tc>/g)) {
      const colW = colWidths[colIdx] ?? totalColW / colWidths.length
      if (/\b[hv]Merge="1"/.test(tcM[1])) {
        colOffset += colW
        colIdx++
        continue
      }
      const text = extractParagraphsText(tcM[2])
      if (text.trim()) {
        blocks.push({
          id: randomUUID(),
          type: 'text',
          content: text,
          x: Math.max(
            0,
            Math.min(1, (xfrm.x + (colOffset / totalColW) * xfrm.cx) / size.cx),
          ),
          y: Math.max(
            0,
            Math.min(1, (xfrm.y + (rowOffset / totalRowH) * xfrm.cy) / size.cy),
          ),
          w: Math.max(0, Math.min(1, ((colW / totalColW) * xfrm.cx) / size.cx)),
          h: Math.max(
            0,
            Math.min(1, ((row.heightEmu / totalRowH) * xfrm.cy) / size.cy),
          ),
        })
      }
      colOffset += colW
      colIdx++
    }
    rowOffset += row.heightEmu
  }
  return blocks
}

function extractFirstAlignment(xml: string): Align | undefined {
  const m = xml.match(/<a:pPr\b[^>]*\salgn="([a-z]+)"/)
  if (!m) return undefined
  if (m[1] === 'l') return 'left'
  if (m[1] === 'ctr') return 'center'
  if (m[1] === 'r') return 'right'
  return undefined
}

function extractFirstRunStyle(xml: string) {
  const out: { fontSize?: number; bold?: boolean; italic?: boolean; color?: string } =
    {}
  for (const m of xml.matchAll(/<a:r\b[^>]*>([\s\S]*?)<\/a:r>/g)) {
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
    }
    break
  }
  return out
}

async function readImageEmbeds(zip: JSZip, slidePath: string) {
  const m = slidePath.match(/^ppt\/slides\/(slide\d+)\.xml$/)
  if (!m) return new Map<string, string>()
  const relsPath = `ppt/slides/_rels/${m[1]}.xml.rels`
  const relsXml = await zip.file(relsPath)?.async('string')
  if (!relsXml) return new Map<string, string>()
  const out = new Map<string, string>()
  const relRe =
    /<Relationship\s+[^>]*Id="([^"]+)"[^>]*Type="[^"]*\/image"[^>]*Target="([^"]+)"/g
  for (const rel of relsXml.matchAll(relRe)) {
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
    out.set(rel[1], `data:${mime};base64,${buf}`)
  }
  return out
}

async function parseSlideXml(
  slideXml: string,
  size: { cx: number; cy: number },
  embeds: Map<string, string>,
): Promise<Block[]> {
  const blocks: Block[] = []

  let shapeIdx = 0
  for (const m of slideXml.matchAll(/<p:sp\b[^>]*>([\s\S]*?)<\/p:sp>/g)) {
    const shapeXml = m[1]
    const text = extractParagraphsText(shapeXml)
    if (!text.trim()) {
      shapeIdx++
      continue
    }
    const xfrm = parseXfrm(shapeXml) ?? {
      x: Math.round(size.cx * 0.05),
      y: Math.round(size.cy * (0.05 + shapeIdx * 0.18)),
      cx: Math.round(size.cx * 0.9),
      cy: Math.round(size.cy * 0.16),
    }
    const style = extractFirstRunStyle(shapeXml)
    const align = extractFirstAlignment(shapeXml)
    blocks.push({
      id: randomUUID(),
      type: 'text',
      content: text,
      x: clamp01(xfrm.x / size.cx),
      y: clamp01(xfrm.y / size.cy),
      w: clamp01(xfrm.cx / size.cx),
      h: clamp01(xfrm.cy / size.cy),
      ...style,
      ...(align ? { align } : {}),
    })
    shapeIdx++
  }

  for (const m of slideXml.matchAll(/<p:pic\b[^>]*>([\s\S]*?)<\/p:pic>/g)) {
    const picXml = m[1]
    const xfrm = parseXfrm(picXml) ?? {
      x: Math.round(size.cx * 0.1),
      y: Math.round(size.cy * 0.1),
      cx: Math.round(size.cx * 0.4),
      cy: Math.round(size.cy * 0.4),
    }
    const embedM = picXml.match(/<a:blip\s+[^>]*r:embed="([^"]+)"/)
    const url = embedM ? (embeds.get(embedM[1]) ?? '') : ''
    blocks.push({
      id: randomUUID(),
      type: 'image',
      url,
      x: clamp01(xfrm.x / size.cx),
      y: clamp01(xfrm.y / size.cy),
      w: clamp01(xfrm.cx / size.cx),
      h: clamp01(xfrm.cy / size.cy),
    })
  }

  for (const m of slideXml.matchAll(
    /<p:graphicFrame\b[^>]*>([\s\S]*?)<\/p:graphicFrame>/g,
  )) {
    blocks.push(...extractTableBlocks(m[1], size))
  }

  return blocks
}

function fmtPct(n: number) {
  return `${(n * 100).toFixed(1)}%`
}

async function main() {
  const buf = await fs.readFile(PPTX_PATH)
  const zip = await JSZip.loadAsync(buf)
  const size = await readSlideSize(zip)

  const slidePaths = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => {
      const na = Number(a.match(/slide(\d+)\.xml$/)![1])
      const nb = Number(b.match(/slide(\d+)\.xml$/)![1])
      return na - nb
    })

  console.log(`file: ${path.basename(PPTX_PATH)} (${buf.length} bytes)`)
  console.log(
    `slide size: ${size.cx} × ${size.cy} EMU (${(size.cx / 914400).toFixed(2)}in × ${(size.cy / 914400).toFixed(2)}in)`,
  )
  console.log(`slides: ${slidePaths.length}`)
  console.log('')

  let totalBlocks = 0
  let totalImages = 0
  let blocksWithFont = 0
  let blocksWithColor = 0
  let blocksWithAlign = 0
  let imagesWithUrl = 0

  for (let i = 0; i < slidePaths.length; i++) {
    const xml = await zip.file(slidePaths[i])!.async('string')
    const embeds = await readImageEmbeds(zip, slidePaths[i])
    const blocks = await parseSlideXml(xml, size, embeds)
    totalBlocks += blocks.length

    const textBlocks = blocks.filter(
      (b): b is TextBlock => b.type === 'text',
    )
    const imgBlocks = blocks.filter(
      (b): b is ImageBlock => b.type === 'image',
    )
    totalImages += imgBlocks.length
    blocksWithFont += textBlocks.filter((b) => b.fontSize != null).length
    blocksWithColor += textBlocks.filter((b) => b.color != null).length
    blocksWithAlign += textBlocks.filter((b) => b.align != null).length
    imagesWithUrl += imgBlocks.filter((b) => b.url.length > 0).length

    console.log(
      `slide ${i + 1}: ${blocks.length} block(s)  text=${textBlocks.length} image=${imgBlocks.length} (with-data=${imgBlocks.filter((b) => b.url).length})`,
    )
    blocks.slice(0, 4).forEach((b, j) => {
      const box = `(${fmtPct(b.x)}, ${fmtPct(b.y)})  ${fmtPct(b.w)}×${fmtPct(b.h)}`
      if (b.type === 'text') {
        const props = [
          b.fontSize != null ? `${b.fontSize}pt` : null,
          b.color,
          b.bold ? 'bold' : null,
          b.italic ? 'italic' : null,
          b.align,
        ].filter(Boolean).join(' ')
        const preview = b.content.replace(/\s+/g, ' ').slice(0, 40)
        console.log(
          `    [${j}] text  ${box}  ${props ? `[${props}]` : ''}  "${preview}${b.content.length > 40 ? '…' : ''}"`,
        )
      } else {
        console.log(
          `    [${j}] image ${box}  url=${b.url ? b.url.slice(0, 40) + '…' : '(missing)'}`,
        )
      }
    })
    if (blocks.length > 4) console.log(`    ... +${blocks.length - 4} more`)
  }

  console.log('')
  console.log(`SUMMARY: slides=${slidePaths.length}`)
  console.log(`  total blocks: ${totalBlocks}`)
  console.log(`  text blocks with explicit fontSize: ${blocksWithFont}`)
  console.log(`  text blocks with explicit color:    ${blocksWithColor}`)
  console.log(`  text blocks with explicit align:    ${blocksWithAlign}`)
  console.log(`  image blocks: ${totalImages} (with-data=${imagesWithUrl})`)
}

main().then(() => process.exit(0))
