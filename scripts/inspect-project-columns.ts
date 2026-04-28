import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import 'dotenv/config'

async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg(process.env.DATABASE_URL!),
  })

  const r = await db.$queryRawUnsafe<{
    column_name: string
    data_type: string
    is_nullable: string
    column_default: string | null
  }[]>(
    `SELECT column_name, data_type, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_name = 'Project'
     ORDER BY ordinal_position`,
  )
  for (const row of r) {
    console.log(
      `${row.column_name.padEnd(20)} ${row.data_type.padEnd(20)} null=${row.is_nullable} default=${row.column_default ?? '-'}`,
    )
  }
}

main().then(() => process.exit(0))
