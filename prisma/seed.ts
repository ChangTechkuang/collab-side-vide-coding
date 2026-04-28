import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import 'dotenv/config'

export const DEV_USER_ID = 'dev-user'
export const DEV_USER_EMAIL = 'dev@collabslide.local'

async function main() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set')
  const db = new PrismaClient({ adapter: new PrismaPg(url) })

  await db.user.upsert({
    where: { id: DEV_USER_ID },
    create: {
      id: DEV_USER_ID,
      email: DEV_USER_EMAIL,
      passwordHash: '',
      name: 'Dev User',
    },
    update: {},
  })

  console.log(`Seeded dev user: ${DEV_USER_EMAIL}`)
}

main()
