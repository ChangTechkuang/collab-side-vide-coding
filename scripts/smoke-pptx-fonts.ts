import JSZip from 'jszip'
import fs from 'node:fs/promises'

async function main() {
  const path =
    process.argv[2] ?? 'C:\\Users\\DELL\\Downloads\\sample.pptx'
  const z = await JSZip.loadAsync(await fs.readFile(path))
  const slidePaths = Object.keys(z.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort()

  const allFaces = new Map<string, number>()

  for (const sp of slidePaths) {
    const xml = await z.file(sp)!.async('string')
    for (const m of xml.matchAll(
      /<a:(latin|ea|cs)\s+[^>]*typeface="([^"]+)"/g,
    )) {
      const key = `${m[1]}=${m[2]}`
      allFaces.set(key, (allFaces.get(key) ?? 0) + 1)
    }
  }

  console.log(`scanned ${slidePaths.length} slides`)
  console.log('distinct typefaces:')
  for (const [k, v] of [...allFaces.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}  (×${v})`)
  }
}

main().then(() => process.exit(0))
