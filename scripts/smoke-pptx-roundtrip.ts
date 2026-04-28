// Round-trip: build a PPTX with pptxgenjs, then parse it with our parsePptx
// regex extractor (mirrored from src/actions/import.ts) to confirm text flows
// back through correctly.
import PptxGenJS from 'pptxgenjs'
import JSZip from 'jszip'
import { randomUUID } from 'node:crypto'

type Block =
  | { id: string; type: 'text'; content: string }
  | { id: string; type: 'image'; url: string; alt?: string }

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
}

function extractBlocksFromSlideXml(xml: string): Block[] {
  const blocks: Block[] = []
  const paraRe = /<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g
  const textRe = /<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g
  for (const paraM of xml.matchAll(paraRe)) {
    let paraText = ''
    for (const textM of paraM[1].matchAll(textRe)) {
      paraText += decodeXmlEntities(textM[1])
    }
    const trimmed = paraText.trim()
    if (trimmed) {
      blocks.push({ id: randomUUID(), type: 'text', content: trimmed })
    }
  }
  return blocks
}

async function parsePptx(buffer: Buffer) {
  const zip = await JSZip.loadAsync(buffer)
  const slidePaths = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => {
      const na = Number(a.match(/slide(\d+)\.xml$/)![1])
      const nb = Number(b.match(/slide(\d+)\.xml$/)![1])
      return na - nb
    })
  const slides: { blocks: Block[] }[] = []
  for (const p of slidePaths) {
    const xml = await zip.file(p)!.async('string')
    slides.push({ blocks: extractBlocksFromSlideXml(xml) })
  }
  return slides
}

async function buildFixturePptx(): Promise<Buffer> {
  const pres = new PptxGenJS()
  pres.layout = 'LAYOUT_WIDE'

  // slide 1: two separate shapes (title + body)
  const s1 = pres.addSlide()
  s1.addText('Slide one title', { x: 0.5, y: 0.5, w: 12, h: 1, fontSize: 32 })
  s1.addText('First bullet line', { x: 0.5, y: 2, w: 12, h: 1, fontSize: 18 })

  // slide 2: one shape with three paragraph lines plus an entity
  const s2 = pres.addSlide()
  s2.addText('Line A\nLine B & special\nLine C', {
    x: 0.5,
    y: 0.5,
    w: 12,
    h: 2,
    fontSize: 20,
  })

  // slide 3: title + body with two bullets — total 3 paragraphs
  const s3 = pres.addSlide()
  s3.addText('Final', { x: 0.5, y: 0.5, w: 12, h: 1, fontSize: 28 })
  s3.addText('Bullet one\nBullet two', {
    x: 0.5,
    y: 2,
    w: 12,
    h: 2,
    fontSize: 18,
  })

  // slide 4: no text, only an empty shape area — should yield 0 blocks
  pres.addSlide()

  return (await pres.write({ outputType: 'nodebuffer' })) as Buffer
}

async function main() {
  const fixture = await buildFixturePptx()
  console.log(`fixture pptx: ${fixture.length} bytes`)
  const slides = await parsePptx(fixture)
  console.log(`parsed slides=${slides.length}`)
  slides.forEach((s, i) => {
    console.log(
      `slide ${i + 1}: ${s.blocks.length} blocks ->`,
      s.blocks.map((b) => `[${b.type}] ${JSON.stringify(b.type === 'text' ? b.content : b)}`),
    )
  })
}

main().then(() => process.exit(0))
