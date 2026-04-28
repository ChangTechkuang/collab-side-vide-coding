import type { NextRequest } from 'next/server'
import PptxGenJS from 'pptxgenjs'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/current-user'
import { parseSlideContent, type Block } from '@/lib/slide-types'

function safeFilename(title: string) {
  const cleaned = title.replace(/[^\w\-. ]+/g, '_').trim() || 'presentation'
  return `${cleaned}.pptx`
}

function pptxAlign(a?: 'left' | 'center' | 'right') {
  if (a === 'center') return 'center'
  if (a === 'right') return 'right'
  return 'left'
}

function placeBlock(
  slide: PptxGenJS.Slide,
  block: Block,
  slideWIn: number,
  slideHIn: number,
) {
  const x = block.x * slideWIn
  const y = block.y * slideHIn
  const w = block.w * slideWIn
  const h = block.h * slideHIn

  if (block.type === 'text') {
    if (!block.content) return
    slide.addText(block.content, {
      x,
      y,
      w,
      h,
      fontSize: block.fontSize ?? 18,
      ...(block.fontFamily ? { fontFace: block.fontFamily } : {}),
      color: (block.color ?? '#111111').replace('#', ''),
      bold: block.bold ?? false,
      italic: block.italic ?? false,
      align: pptxAlign(block.align),
      valign: 'top',
    })
    return
  }
  if (block.type === 'image') {
    if (!block.url) return
    slide.addImage({
      ...(block.url.startsWith('data:')
        ? { data: block.url }
        : { path: block.url }),
      x,
      y,
      w,
      h,
      sizing: { type: 'contain', w, h },
    })
    return
  }
  if (block.type === 'line') {
    slide.addShape('line', {
      x,
      y,
      w,
      h,
      line: {
        color: (block.color ?? '#000000').replace('#', ''),
        width: block.thickness ?? 1,
      },
    })
    return
  }
  // Table
  const colW = block.colWidths
    ? block.colWidths.map((f) => f * w)
    : Array.from({ length: block.cols }, () => w / block.cols)
  const rowH = block.rowHeights
    ? block.rowHeights.map((f) => f * h)
    : Array.from({ length: block.rows }, () => h / block.rows)
  const tableRows = block.cells.map((row, i) =>
    row.map((cell) => ({
      text: cell.content,
      options: {
        rowH: rowH[i],
        valign: 'top' as const,
      },
    })),
  )
  slide.addTable(tableRows, {
    x,
    y,
    w,
    h,
    colW,
    fontSize: block.fontSize ?? 11,
    ...(block.fontFamily ? { fontFace: block.fontFamily } : {}),
    color: (block.color ?? '#111111').replace('#', ''),
    bold: block.bold ?? false,
    border: { type: 'solid', pt: 0.5, color: 'CCCCCC' },
  })
}

export async function GET(
  _req: NextRequest,
  ctx: RouteContext<'/projects/[id]/export'>,
) {
  const { id } = await ctx.params
  const user = await getCurrentUser()

  const project = await db.project.findFirst({
    where: { id, members: { some: { userId: user.id } } },
    include: { slides: { orderBy: { order: 'asc' } } },
  })
  if (!project) return new Response('Not found', { status: 404 })

  const pres = new PptxGenJS()
  pres.defineLayout({
    name: 'CUSTOM',
    width: project.slideWidthIn,
    height: project.slideHeightIn,
  })
  pres.layout = 'CUSTOM'
  pres.title = project.title

  for (const row of project.slides) {
    const content = parseSlideContent(row.content)
    const slide = pres.addSlide()
    for (const block of content.blocks) {
      placeBlock(slide, block, project.slideWidthIn, project.slideHeightIn)
    }
  }

  const buffer = (await pres.write({ outputType: 'nodebuffer' })) as Buffer

  return new Response(buffer as unknown as BodyInit, {
    status: 200,
    headers: {
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'Content-Disposition': `attachment; filename="${safeFilename(project.title)}"`,
      'Cache-Control': 'no-store',
    },
  })
}
