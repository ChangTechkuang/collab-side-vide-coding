import type { CSSProperties, ReactNode, Ref } from 'react'

// Slide canvas wrapper. Establishes the relative-positioning context for
// absolutely-positioned BlockElements and locks aspect ratio to the source
// slide dimensions.
export function Container({
  widthIn = 13.333,
  heightIn = 7.5,
  background,
  children,
  className,
  refEl,
  onPointerDown,
  style,
}: {
  widthIn?: number
  heightIn?: number
  background?: string
  children: ReactNode
  className?: string
  refEl?: Ref<HTMLDivElement>
  onPointerDown?: React.PointerEventHandler<HTMLDivElement>
  style?: CSSProperties
}) {
  return (
    <div
      ref={refEl}
      onPointerDown={onPointerDown}
      className={`relative ${className ?? ''}`}
      style={{
        aspectRatio: `${widthIn} / ${heightIn}`,
        backgroundColor: background ?? '#ffffff',
        ...style,
      }}
    >
      {children}
    </div>
  )
}
