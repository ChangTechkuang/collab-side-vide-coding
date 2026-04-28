import { notFound } from 'next/navigation'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/current-user'
import { parseSlideContent, type SlideData } from '@/lib/slide-types'
import Editor from './editor'

type SlideRow = { id: string; order: number; content: unknown }

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const user = await getCurrentUser()

  const project = await db.project.findFirst({
    where: {
      id,
      members: { some: { userId: user.id } },
    },
    include: {
      slides: { orderBy: { order: 'asc' } },
    },
  })

  if (!project) notFound()

  const initialSlides: SlideData[] = project.slides.map((s: SlideRow) => ({
    id: s.id,
    order: s.order,
    content: parseSlideContent(s.content),
  }))

  // Defensive defaults: legacy rows may have null if the migration ran
  // against existing data without backfill.
  const slideWidthIn =
    typeof project.slideWidthIn === 'number' && project.slideWidthIn > 0
      ? project.slideWidthIn
      : 13.333
  const slideHeightIn =
    typeof project.slideHeightIn === 'number' && project.slideHeightIn > 0
      ? project.slideHeightIn
      : 7.5

  return (
    <Editor
      projectId={project.id}
      projectTitle={project.title}
      initialSlides={initialSlides}
      slideWidthIn={slideWidthIn}
      slideHeightIn={slideHeightIn}
    />
  )
}
