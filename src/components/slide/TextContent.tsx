import type { TextBlock } from '@/lib/slide-types'
import { RunsView, textStyle } from './utils'

// Pure read-only renderer for a TextBlock. No state, no events — usable
// from Server Components, the editor's read mode, or static exports.
export function TextContent({
  block,
  className,
  placeholder,
}: {
  block: TextBlock
  className?: string
  placeholder?: React.ReactNode
}) {
  return (
    <div
      data-block-id={block.id}
      className={`h-full w-full whitespace-pre-wrap break-words leading-tight ${className ?? ''}`}
      style={textStyle(block)}
    >
      {block.runs && block.runs.length > 0 ? (
        <RunsView runs={block.runs} />
      ) : block.content ? (
        block.content
      ) : (
        placeholder
      )}
    </div>
  )
}
