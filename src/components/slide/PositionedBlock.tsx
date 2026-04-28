import type { Block } from '@/lib/slide-types'
import { BlockContent } from './BlockContent'
import { blockBoxStyle } from './utils'

// Absolutely-positioned wrapper around BlockContent. Standalone use:
//   <Container>{blocks.map(b => <PositionedBlock key={b.id} block={b} />)}</Container>
//
// Pass `zIndex` to override the natural document order — pre-Phase-7 we
// stack everything at zIndex=auto (document order); the editor adds its
// own selection-aware z-index by wrapping this component.
export function PositionedBlock({
  block,
  zIndex,
  className,
}: {
  block: Block
  zIndex?: number
  className?: string
}) {
  return (
    <div
      style={blockBoxStyle(block, zIndex)}
      className={`overflow-hidden ${className ?? ''}`}
    >
      <BlockContent block={block} />
    </div>
  )
}
