import Link from 'next/link'
import { getCurrentUser } from '@/lib/current-user'

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const user = await getCurrentUser()

  return (
    <div className="flex min-h-full flex-col">
      <header className="flex items-center justify-between border-b border-zinc-200 bg-white px-6 py-3 dark:border-zinc-800 dark:bg-zinc-950">
        <Link
          href="/dashboard"
          className="text-base font-semibold tracking-tight"
        >
          CollabSlide
        </Link>
        <span className="text-sm text-zinc-500">{user.email}</span>
      </header>
      <main className="flex flex-1 flex-col">{children}</main>
    </div>
  )
}
