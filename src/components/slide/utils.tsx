import type { CSSProperties } from 'react'
import type { Block, TextBlock, TextRun } from '@/lib/slide-types'

// Standard CSS for a slide block: absolute-positioned with x/y/w/h as fractions.
export function blockBoxStyle(
  block: Block,
  zIndex?: number,
): CSSProperties {
  return {
    position: 'absolute',
    left: `${block.x * 100}%`,
    top: `${block.y * 100}%`,
    width: `${block.w * 100}%`,
    height: `${block.h * 100}%`,
    zIndex,
  }
}

// Known-safe Korean/CJK web fonts that compose Hangul correctly.
// When the PPTX specifies a font not on this list, we drop it and rely on
// the safe fallback chain so Korean characters don't decompose into jamo.
const SAFE_FONT_RE =
  /^(malgun gothic|맑은 고딕|apple sd gothic neo|나눔고딕|nanum gothic|nanumgothic|noto sans|noto sans kr|gulim|batang|dotum|gulimche|batangche|dotumche|arial|helvetica|times new roman|georgia|verdana|tahoma|calibri|cambria|courier new)$/i

export function safeFontFamily(face: string | undefined): string | undefined {
  if (!face) return undefined
  // Theme-ref placeholders like "+mn-ea" are not real fonts — skip them.
  if (face.startsWith('+')) return undefined
  // If the face name contains a safe font, use the system fallback chain
  // (the font itself may or may not be installed, the fallbacks will cover it).
  // If it's a completely unknown/proprietary font, drop it entirely so the
  // browser uses a Korean-capable system font and doesn't decompose Hangul.
  if (SAFE_FONT_RE.test(face.trim())) {
    return `"${face}", "Malgun Gothic", "Apple SD Gothic Neo", "Nanum Gothic", sans-serif`
  }
  // Unknown fonts: still include them (they might be installed) but ensure
  // Korean-capable fonts come right after so jamo don't appear.
  return `"${face}", "Malgun Gothic", "Apple SD Gothic Neo", "Nanum Gothic", sans-serif`
}

// Block-level text styling (used when no per-run runs are set, or as the
// inheritable default for runs that omit fields).
export function textStyle(block: TextBlock): CSSProperties {
  return {
    fontSize: block.fontSize ? `${block.fontSize}pt` : undefined,
    fontFamily: safeFontFamily(block.fontFamily),
    color: block.color,
    fontWeight: block.bold ? 700 : undefined,
    fontStyle: block.italic ? 'italic' : undefined,
    textAlign: block.align,
    // Line spacing: convert multiplier to CSS line-height (default 1.2 if unset)
    lineHeight: block.lineSpacing ? block.lineSpacing : undefined,
  }
}

// Per-run styling for rich text fragments.
export function runStyle(run: TextRun): CSSProperties {
  return {
    fontSize: run.fontSize ? `${run.fontSize}pt` : undefined,
    fontFamily: safeFontFamily(run.fontFamily),
    color: run.color,
    fontWeight: run.bold ? 700 : undefined,
    fontStyle: run.italic ? 'italic' : undefined,
    textDecoration: run.underline ? 'underline' : undefined,
  }
}


// Render runs as inline <span>s. Paragraph breaks live as `\n` inside
// run.text and are honored by `whitespace: pre-wrap` on the parent.
export function RunsView({ runs }: { runs: TextRun[] }) {
  return (
    <>
      {runs.map((r, i) => (
        <span key={i} style={runStyle(r)}>
          {r.text}
        </span>
      ))}
    </>
  )
}
