import type { CSSProperties } from 'react'
import type { TableBlock } from '@/lib/slide-types'
import { RunsView } from './utils'

function tableTextStyle(block: TableBlock): CSSProperties {
  return {
    fontSize: block.fontSize ? `${block.fontSize}pt` : undefined,
    fontFamily: block.fontFamily
      ? `"${block.fontFamily}", "Malgun Gothic", "Apple SD Gothic Neo", sans-serif`
      : undefined,
    color: block.color,
    fontWeight: block.bold ? 700 : undefined,
  }
}

// Pure read-only renderer for a TableBlock.
export function TableContent({
  block,
  className,
}: {
  block: TableBlock
  className?: string
}) {
  return (
    <table
      data-block-id={block.id}
      className={`h-full w-full table-fixed border-collapse ${className ?? ''}`}
      style={tableTextStyle(block)}
    >
      <colgroup>
        {Array.from({ length: block.cols }).map((_, j) => (
          <col
            key={j}
            style={{
              width: block.colWidths
                ? `${block.colWidths[j] * 100}%`
                : `${100 / block.cols}%`,
            }}
          />
        ))}
      </colgroup>
      <tbody>
        {block.cells.map((row, i) => (
          <tr
            key={i}
            style={{
              height: block.rowHeights
                ? `${block.rowHeights[i] * 100}%`
                : `${100 / block.rows}%`,
            }}
          >
            {row.map((cell) => (
              <td
                key={cell.id}
                data-cell-id={cell.id}
                className="overflow-hidden border border-zinc-300 px-1 align-top dark:border-zinc-700"
              >
                <div className="overflow-hidden whitespace-pre-wrap break-words leading-tight">
                  {cell.runs && cell.runs.length > 0 ? (
                    <RunsView runs={cell.runs} />
                  ) : (
                    cell.content
                  )}
                </div>
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
