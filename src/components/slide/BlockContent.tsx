import type { Block } from '@/lib/slide-types'
import { ImageContent } from './ImageContent'
import { ShapeContent } from './ShapeContent'
import { TableContent } from './TableContent'
import { TextContent } from './TextContent'

// Type-discriminated dispatcher: renders the right pure content component
// based on block.type. No positioning — wrap with PositionedBlock or your
// own absolutely-positioned container.
export function BlockContent({
  block,
  className,
}: {
  block: Block
  className?: string
}) {
  switch (block.type) {
    case 'text':
      return <TextContent block={block} className={className} />
    case 'image':
      return <ImageContent block={block} className={className} />
    case 'line':
      return <ShapeContent block={block} className={className} />
    case 'table':
      return <TableContent block={block} className={className} />
  }
}
