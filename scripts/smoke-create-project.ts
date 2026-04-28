import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import 'dotenv/config'

async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg(process.env.DATABASE_URL!),
  })

  const existing = await db.project.findFirst({
    where: { ownerId: 'dev-user' },
  })

  if (existing) {
    console.log(existing.id)
    return
  }

  const p = await db.project.create({
    data: {
      title: 'Smoke test project',
      ownerId: 'dev-user',
      slides: { create: { order: 0, content: { blocks: [] } } },
      members: { create: { userId: 'dev-user', role: 'OWNER' } },
    },
  })
  console.log(p.id)
}

main().then(() => process.exit(0))
