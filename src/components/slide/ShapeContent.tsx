import type { LineBlock } from '@/lib/slide-types'

// Pure read-only renderer for a LineBlock (for now the only shape kind).
// Fills the bounding box with the line color; thin boxes look like thin
// lines naturally without needing extra geometry.
export function ShapeContent({
  block,
  className,
}: {
  block: LineBlock
  className?: string
}) {
  return (
    <div
      data-block-id={block.id}
      className={`h-full w-full ${className ?? ''}`}
      style={{ backgroundColor: block.color ?? '#000000' }}
    />
  )
}
