'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/current-user'
import {
  emptySlideContent,
  type SlideContent,
  type SlideData,
} from '@/lib/slide-types'

async function requireWriteAccess(projectId: string) {
  const user = await getCurrentUser()
  const membership = await db.membership.findUnique({
    where: { userId_projectId: { userId: user.id, projectId } },
  })
  if (!membership || membership.role === 'VIEWER') {
    throw new Error('Forbidden')
  }
  return { user, membership }
}

const BoxFields = {
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
}

const AlignSchema = z.enum(['left', 'center', 'right'])

const TextRunSchema = z.object({
  text: z.string(),
  fontSize: z.number().optional(),
  fontFamily: z.string().optional(),
  color: z.string().optional(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
})

const TableCellSchema = z.object({
  id: z.string().min(1),
  content: z.string(),
  runs: z.array(TextRunSchema).optional(),
})

const BlockSchema = z.discriminatedUnion('type', [
  z.object({
    id: z.string().min(1),
    type: z.literal('text'),
    content: z.string(),
    runs: z.array(TextRunSchema).optional(),
    ...BoxFields,
    fontSize: z.number().optional(),
    fontFamily: z.string().optional(),
    color: z.string().optional(),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    align: AlignSchema.optional(),
  }),
  z.object({
    id: z.string().min(1),
    type: z.literal('image'),
    url: z.string(),
    alt: z.string().optional(),
    ...BoxFields,
  }),
  z.object({
    id: z.string().min(1),
    type: z.literal('line'),
    ...BoxFields,
    color: z.string().optional(),
    thickness: z.number().optional(),
  }),
  z.object({
    id: z.string().min(1),
    type: z.literal('table'),
    rows: z.number().int().positive(),
    cols: z.number().int().positive(),
    cells: z.array(z.array(TableCellSchema)),
    colWidths: z.array(z.number()).optional(),
    rowHeights: z.array(z.number()).optional(),
    fontSize: z.number().optional(),
    fontFamily: z.string().optional(),
    color: z.string().optional(),
    bold: z.boolean().optional(),
    ...BoxFields,
  }),
])

const SlideContentSchema = z.object({
  blocks: z.array(BlockSchema),
  background: z.string().optional(),
})

export async function saveSlide(slideId: string, content: SlideContent) {
  const slide = await db.slide.findUnique({
    where: { id: slideId },
    select: { projectId: true },
  })
  if (!slide) throw new Error('Slide not found')
  await requireWriteAccess(slide.projectId)

  const parsed = SlideContentSchema.parse(content)
  await db.slide.update({
    where: { id: slideId },
    // JSON round-trip strips `undefined` optional fields that Prisma's JSON
    // column serializer rejects.
    data: {
      content: JSON.parse(JSON.stringify(parsed)) as Prisma.InputJsonValue,
    },
  })
}

export async function addSlide(projectId: string): Promise<SlideData> {
  await requireWriteAccess(projectId)
  const last = await db.slide.findFirst({
    where: { projectId },
    orderBy: { order: 'desc' },
    select: { order: true },
  })
  const order = (last?.order ?? -1) + 1
  const created = await db.slide.create({
    data: {
      projectId,
      order,
      content: emptySlideContent() as unknown as Prisma.InputJsonValue,
    },
  })
  revalidatePath(`/projects/${projectId}`)
  return {
    id: created.id,
    order: created.order,
    content: emptySlideContent(),
  }
}

export async function deleteSlide(projectId: string, slideId: string) {
  await requireWriteAccess(projectId)
  await db.slide.delete({ where: { id: slideId } })
  revalidatePath(`/projects/${projectId}`)
}

export async function reorderSlides(projectId: string, slideIds: string[]) {
  await requireWriteAccess(projectId)
  await db.$transaction(
    slideIds.map((id, idx) =>
      db.slide.update({ where: { id }, data: { order: idx } }),
    ),
  )
  revalidatePath(`/projects/${projectId}`)
}
