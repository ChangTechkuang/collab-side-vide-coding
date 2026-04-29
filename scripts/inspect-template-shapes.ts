import JSZip from 'jszip'
import fs from 'node:fs/promises'

async function main() {
  const path = process.argv[2] ?? 'C:\\Users\\DELL\\Downloads\\sample.pptx'
  const buf = await fs.readFile(path)
  const zip = await JSZip.loadAsync(buf)

  for (const name of Object.keys(zip.files).sort()) {
    if (!/^ppt\/(slideLayouts|slideMasters)\/[^/]+\.xml$/.test(name)) continue
    const xml = await zip.file(name)!.async('string')
    const sps = [...xml.matchAll(/<p:sp\b[^>]*>([\s\S]*?)<\/p:sp>/g)]
    const cxns = [...xml.matchAll(/<p:cxnSp\b[^>]*>([\s\S]*?)<\/p:cxnSp>/g)]
    const pics = [...xml.matchAll(/<p:pic\b[^>]*>([\s\S]*?)<\/p:pic>/g)]
    if (sps.length === 0 && cxns.length === 0 && pics.length === 0) continue

    console.log(`\n=== ${name}  sp=${sps.length} cxn=${cxns.length} pic=${pics.length} ===`)
    for (let i = 0; i < sps.length; i++) {
      const inner = sps[i][1]
      const isPh = /<p:ph\b/.test(inner)
      const hasText = /<a:t\b[^>]*>[^<]+/.test(inner)
      const fillRgb = /<p:spPr\b[^>]*>[\s\S]*?<a:solidFill>\s*<a:srgbClr/.test(inner)
      const fillScheme = /<p:spPr\b[^>]*>[\s\S]*?<a:solidFill>\s*<a:schemeClr/.test(inner)
      const lnRgb = /<a:ln\b[^>]*>[\s\S]*?<a:srgbClr/.test(inner)
      const lnScheme = /<a:ln\b[^>]*>[\s\S]*?<a:schemeClr/.test(inner)
      const lnW = inner.match(/<a:ln\b[^>]*\sw="(\d+)"/)?.[1]
      const prst = inner.match(/<a:prstGeom\s+[^>]*prst="([^"]+)"/)?.[1]
      const xfrm = inner.match(/<a:off\s+[^>]*x="(-?\d+)"[^>]*y="(-?\d+)"[^>]*\/>[\s\S]*?<a:ext\s+[^>]*cx="(\d+)"[^>]*cy="(\d+)"/)
      const dim = xfrm ? `[${xfrm[1]},${xfrm[2]} ${xfrm[3]}x${xfrm[4]}]` : '?'
      console.log(`  sp[${i}] ph=${isPh} text=${hasText} prst=${prst ?? '-'} fill=${fillRgb ? 'rgb' : fillScheme ? 'scheme' : '-'} ln=${lnRgb ? 'rgb' : lnScheme ? 'scheme' : '-'} lnW=${lnW ?? '-'} ${dim}`)
    }
    for (let i = 0; i < cxns.length; i++) {
      const inner = cxns[i][1]
      const xfrm = inner.match(/<a:off\s+[^>]*x="(-?\d+)"[^>]*y="(-?\d+)"[^>]*\/>[\s\S]*?<a:ext\s+[^>]*cx="(\d+)"[^>]*cy="(\d+)"/)
      const dim = xfrm ? `[${xfrm[1]},${xfrm[2]} ${xfrm[3]}x${xfrm[4]}]` : '?'
      const lnRgb = /<a:ln\b[^>]*>[\s\S]*?<a:srgbClr/.test(inner)
      const lnScheme = /<a:ln\b[^>]*>[\s\S]*?<a:schemeClr/.test(inner)
      const lnW = inner.match(/<a:ln\b[^>]*\sw="(\d+)"/)?.[1]
      console.log(`  cxn[${i}] ln=${lnRgb ? 'rgb' : lnScheme ? 'scheme' : '-'} lnW=${lnW ?? '-'} ${dim}`)
    }
  }
}

main()
