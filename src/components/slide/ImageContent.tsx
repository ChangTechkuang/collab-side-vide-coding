import type { ImageBlock } from '@/lib/slide-types'

// Pure read-only renderer for an ImageBlock. Uses a plain <img> so any URL
// (including data: URLs from PPTX imports) renders without next/image's
// remote-host configuration.
export function ImageContent({
  block,
  className,
  placeholder,
}: {
  block: ImageBlock
  className?: string
  placeholder?: React.ReactNode
}) {
  if (!block.url) {
    return (
      <div
        data-block-id={block.id}
        className={`flex h-full w-full items-center justify-center bg-zinc-100 text-[10px] text-zinc-400 dark:bg-zinc-900 ${className ?? ''}`}
      >
        {placeholder ?? 'image'}
      </div>
    )
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      data-block-id={block.id}
      src={block.url}
      alt={block.alt ?? ''}
      draggable={false}
      className={`h-full w-full object-contain ${className ?? ''}`}
    />
  )
}
