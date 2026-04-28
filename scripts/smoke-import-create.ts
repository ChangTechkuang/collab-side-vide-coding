// Inline reproduce of import.ts logic so we can see the actual Prisma error.
import fs from 'node:fs/promises'
import JSZip from 'jszip'
import { PrismaClient, Prisma } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { randomUUID } from 'node:crypto'
import 'dotenv/config'

const PPTX_PATH =
  process.argv[2] ?? 'C:\\Users\\DELL\\Downloads\\sample.pptx'

const DEFAULT_CX = 12_192_000
const DEFAULT_CY = 6_858_000

function decode(s: string) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
}

function clamp01(n: number) {
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0
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

function extractParagraphsText(xml: string) {
  const lines: string[] = []
  for (const p of xml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)) {
    let line = ''
    for (const t of p[1].matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g)) {
      line += decode(t[1])
    }
    lines.push(line)
  }
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
  while (lines.length > 0 && lines[0].trim() === '') lines.shift()
  return lines.join('\n')
}

function extractAlign(xml: string) {
  const m = xml.match(/<a:pPr\b[^>]*\salgn="([a-z]+)"/)
  if (!m) return undefined
  if (m[1] === 'l') return 'left'
  if (m[1] === 'ctr') return 'center'
  if (m[1] === 'r') return 'right'
  return undefined
}

function extractStyle(xml: string) {
  const out: Record<string, unknown> = {}
  for (const r of xml.matchAll(/<a:r\b[^>]*>([\s\S]*?)<\/a:r>/g)) {
    if (!/<a:t\b/.test(r[1])) continue
    const rPr = r[1].match(
      /<a:rPr\b([^>]*)>([\s\S]*?)<\/a:rPr>|<a:rPr\b([^>]*)\/>/,
    )
    if (rPr) {
      const attrs = rPr[1] ?? rPr[3] ?? ''
      const inner = rPr[2] ?? ''
      const sz = attrs.match(/\bsz="(\d+)"/)
      if (sz) out.fontSize = Number(sz[1]) / 100
      if (/\bb="1"/.test(attrs)) out.bold = true
      if (/\bi="1"/.test(attrs)) out.italic = true
      const c = inner.match(/<a:srgbClr\s+val="([0-9A-Fa-f]{6})"/)
      if (c) out.color = '#' + c[1].toUpperCase()
      const ea = inner.match(/<a:ea\s+[^>]*typeface="([^"]+)"/)?.[1]
      const latin = inner.match(/<a:latin\s+[^>]*typeface="([^"]+)"/)?.[1]
      const pick = (f?: string) =>
        f && !f.startsWith('+') ? f : undefined
      out.fontFamily = pick(ea) ?? pick(latin)
    }
    break
  }
  return out
}

async function readEmbeds(zip: JSZip, slidePath: string) {
  const m = slidePath.match(/^ppt\/slides\/(slide\d+)\.xml$/)
  if (!m) return new Map<string, string>()
  const xml = await zip.file(`ppt/slides/_rels/${m[1]}.xml.rels`)?.async('string')
  if (!xml) return new Map<string, string>()
  const out = new Map<string, string>()
  const re =
    /<Relationship\s+[^>]*Id="([^"]+)"[^>]*Type="[^"]*\/image"[^>]*Target="([^"]+)"/g
  for (const m of xml.matchAll(re)) {
    const target = m[2].replace(/^\.\.\//, 'ppt/')
    const f = zip.file(target)
    if (!f) continue
    const ext = target.split('.').pop()?.toLowerCase() ?? 'png'
    const mime =
      ext === 'jpg' || ext === 'jpeg'
        ? 'image/jpeg'
        : ext === 'gif'
          ? 'image/gif'
          : ext === 'svg'
            ? 'image/svg+xml'
            : 'image/png'
    const b64 = await f.async('base64')
    out.set(m[1], `data:${mime};base64,${b64}`)
  }
  return out
}

async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg(process.env.DATABASE_URL!),
  })

  const buf = await fs.readFile(PPTX_PATH)
  const zip = await JSZip.loadAsync(buf)

  const presXml = await zip.file('ppt/presentation.xml')?.async('string')
  const sz = presXml?.match(/<p:sldSz\s+[^>]*cx="(\d+)"[^>]*cy="(\d+)"/)
  const size = sz
    ? { cx: Number(sz[1]), cy: Number(sz[2]) }
    : { cx: DEFAULT_CX, cy: DEFAULT_CY }

  const slidePaths = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => {
      const na = Number(a.match(/slide(\d+)\.xml$/)![1])
      const nb = Number(b.match(/slide(\d+)\.xml$/)![1])
      return na - nb
    })

  const slideContents: Array<{ blocks: unknown[] }> = []
  for (const sp of slidePaths) {
    const xml = await zip.file(sp)!.async('string')
    const embeds = await readEmbeds(zip, sp)
    const blocks: unknown[] = []
    let idx = 0
    for (const m of xml.matchAll(/<p:sp\b[^>]*>([\s\S]*?)<\/p:sp>/g)) {
      const shapeXml = m[1]
      const text = extractParagraphsText(shapeXml)
      if (!text.trim()) {
        idx++
        continue
      }
      const xfrm = parseXfrm(shapeXml) ?? {
        x: Math.round(size.cx * 0.05),
        y: Math.round(size.cy * (0.05 + idx * 0.18)),
        cx: Math.round(size.cx * 0.9),
        cy: Math.round(size.cy * 0.16),
      }
      const style = extractStyle(shapeXml)
      const align = extractAlign(shapeXml)
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
      idx++
    }
    for (const m of xml.matchAll(/<p:pic\b[^>]*>([\s\S]*?)<\/p:pic>/g)) {
      const picXml = m[1]
      const xfrm = parseXfrm(picXml) ?? {
        x: Math.round(size.cx * 0.1),
        y: Math.round(size.cy * 0.1),
        cx: Math.round(size.cx * 0.4),
        cy: Math.round(size.cy * 0.4),
      }
      const eM = picXml.match(/<a:blip\s+[^>]*r:embed="([^"]+)"/)
      const url = eM ? (embeds.get(eM[1]) ?? '') : ''
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
    slideContents.push({ blocks })
  }

  console.log(`parsed ${slideContents.length} slides`)

  try {
    const project = await db.project.create({
      data: {
        title: 'sample-script',
        ownerId: 'dev-user',
        slideWidthIn: size.cx / 914400,
        slideHeightIn: size.cy / 914400,
        members: { create: { userId: 'dev-user', role: 'OWNER' } },
        slides: {
          create: slideContents.map((content, idx) => ({
            order: idx,
            content: JSON.parse(JSON.stringify(content)) as Prisma.InputJsonValue,
          })),
        },
      },
    })
    console.log('OK', project.id)
    await db.project.delete({ where: { id: project.id } })
    console.log('cleaned up')
  } catch (err) {
    if (err instanceof Error) {
      console.log('ERROR NAME:', err.name)
      console.log('FULL MESSAGE:')
      console.log(err.message)
    } else {
      console.log('UNKNOWN:', err)
    }
  }
}

main().then(() => process.exit(0))
