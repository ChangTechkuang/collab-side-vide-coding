'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/current-user'

const CreateProjectSchema = z.object({
  title: z.string().min(1, 'Title is required').max(120).trim(),
})

export async function createProject(formData: FormData) {
  const user = await getCurrentUser()
  const parsed = CreateProjectSchema.safeParse({
    title: formData.get('title'),
  })
  if (!parsed.success) return

  const project = await db.project.create({
    data: {
      title: parsed.data.title,
      ownerId: user.id,
      slides: {
        create: {
          order: 0,
          content: { blocks: [] },
        },
      },
      members: {
        create: {
          userId: user.id,
          role: 'OWNER',
        },
      },
    },
  })

  revalidatePath('/dashboard')
  redirect(`/projects/${project.id}`)
}

export async function deleteProject(formData: FormData) {
  const user = await getCurrentUser()
  const id = String(formData.get('id') ?? '')
  if (!id) return

  const project = await db.project.findUnique({
    where: { id },
    select: { ownerId: true },
  })
  if (!project || project.ownerId !== user.id) return

  await db.project.delete({ where: { id } })
  revalidatePath('/dashboard')
}
