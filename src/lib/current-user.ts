import 'server-only'
import { cache } from 'react'
import { db } from './db'

const DEV_USER_ID = 'dev-user'

export const getCurrentUser = cache(async () => {
  const user = await db.user.findUnique({ where: { id: DEV_USER_ID } })
  if (!user) {
    throw new Error(
      `Dev user not found. Run: npx prisma migrate dev && npx prisma db seed`,
    )
  }
  return user
})
