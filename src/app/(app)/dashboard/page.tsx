import Link from 'next/link'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/current-user'
import { createProject, deleteProject } from '@/actions/projects'
import { importPptx } from '@/actions/import'

export default async function DashboardPage() {
  const user = await getCurrentUser()
  const projects = await db.project.findMany({
    where: { members: { some: { userId: user.id } } },
    orderBy: { updatedAt: 'desc' },
    select: {
      id: true,
      title: true,
      updatedAt: true,
      _count: { select: { slides: true } },
    },
  })

  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>

      <form action={createProject} className="mt-6 flex gap-2">
        <input
          name="title"
          required
          maxLength={120}
          placeholder="New presentation title"
          className="flex-1 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-zinc-900 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900"
        />
        <button
          type="submit"
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          Create
        </button>
      </form>

      <form
        action={importPptx}
        className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-dashed border-zinc-300 bg-zinc-50 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
      >
        <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
          Import .pptx
        </span>
        <input
          type="file"
          name="file"
          accept=".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation"
          required
          className="flex-1 text-xs file:mr-3 file:rounded-md file:border-0 file:bg-zinc-900 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-white hover:file:bg-zinc-800 dark:file:bg-white dark:file:text-zinc-900"
        />
        <input
          type="text"
          name="title"
          maxLength={120}
          placeholder="Title (optional)"
          className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-950"
        />
        <button
          type="submit"
          className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-950 dark:hover:bg-zinc-800"
        >
          Import
        </button>
      </form>

      <ul className="mt-8 divide-y divide-zinc-200 rounded-md border border-zinc-200 bg-white dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-950">
        {projects.length === 0 && (
          <li className="px-4 py-6 text-sm text-zinc-500">
            No projects yet. Create one above.
          </li>
        )}
        {projects.map((project) => (
          <li
            key={project.id}
            className="flex items-center justify-between px-4 py-3"
          >
            <Link
              href={`/projects/${project.id}`}
              className="flex-1 text-sm font-medium hover:underline"
            >
              {project.title}
            </Link>
            <span className="mx-4 text-xs text-zinc-500">
              {project._count.slides} slide
              {project._count.slides === 1 ? '' : 's'}
            </span>
            <form action={deleteProject}>
              <input type="hidden" name="id" value={project.id} />
              <button
                type="submit"
                className="text-xs text-red-600 hover:underline"
              >
                Delete
              </button>
            </form>
          </li>
        ))}
      </ul>
    </div>
  )
}
