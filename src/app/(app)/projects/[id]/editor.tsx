'use client'

import {
  useCallback,
  useEffect,
  useRef,
  useTransition,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import Link from 'next/link'
import { useEditor } from '@/lib/editor-store'
import type {
  Block,
  ImageBlock,
  SlideData,
  TableBlock,
  TableCell,
  TextBlock,
  TextRun,
} from '@/lib/slide-types'
import { newTableBlock } from '@/lib/slide-types'
import {
  blockBoxStyle,
  ImageContent,
  PositionedBlock,
  RunsView,
  ShapeContent,
  TextContent,
  textStyle,
} from '@/components/slide'
import {
  addSlide,
  deleteSlide,
  reorderSlides,
  saveSlide,
} from '@/actions/slides'

const AUTOSAVE_DEBOUNCE_MS = 800
const SLIDE_REF_W = 960
const THUMB_SCALE = 0.2
const NUDGE_STEP = 0.01
const NUDGE_STEP_BIG = 0.05
const MIN_BLOCK_FRAC = 0.02
const SNAP_THRESHOLD = 0.006 // ~6px on a 1024px-wide canvas

type ResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

function clamp01(n: number) {
  return Math.max(0, Math.min(1, n))
}

// Build snap candidates from siblings + slide edges/centers.
function snapCandidates(others: Array<{ x: number; y: number; w: number; h: number }>) {
  const v = new Set<number>([0, 0.5, 1])
  const h = new Set<number>([0, 0.5, 1])
  for (const o of others) {
    v.add(o.x)
    v.add(o.x + o.w / 2)
    v.add(o.x + o.w)
    h.add(o.y)
    h.add(o.y + o.h / 2)
    h.add(o.y + o.h)
  }
  return { v: Array.from(v), h: Array.from(h) }
}

// Pick the snap delta that minimizes distance, within threshold.
function bestDelta(myLines: number[], candidates: number[], threshold: number) {
  let bestAbs = Infinity
  let delta = 0
  for (const p of myLines) {
    for (const c of candidates) {
      const d = c - p
      const abs = Math.abs(d)
      if (abs <= threshold && abs < bestAbs) {
        bestAbs = abs
        delta = d
      }
    }
  }
  return bestAbs === Infinity ? null : delta
}

// After applying delta, find ALL candidate lines that the resulting block
// edges/centers now coincide with — those become the visible guides.
function matchingGuides(myLines: number[], delta: number, candidates: number[]) {
  const out = new Set<number>()
  for (const p of myLines) {
    const snapped = p + delta
    for (const c of candidates) {
      if (Math.abs(c - snapped) < 0.0008) out.add(c)
    }
  }
  return Array.from(out)
}

// Get all blocks on the given slide except `excludeId`.
function siblingBoxes(slideId: string, excludeId: string) {
  const slide = useEditor
    .getState()
    .slides.find((s) => s.id === slideId)
  if (!slide) return []
  return slide.content.blocks
    .filter((b) => b.id !== excludeId)
    .map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h }))
}

export default function Editor({
  projectId,
  projectTitle,
  initialSlides,
  slideWidthIn,
  slideHeightIn,
}: {
  projectId: string
  projectTitle: string
  initialSlides: SlideData[]
  slideWidthIn: number
  slideHeightIn: number
}) {
  const init = useEditor((s) => s.init)
  useEffect(() => {
    init(projectId, initialSlides, slideWidthIn, slideHeightIn)
  }, [init, projectId, initialSlides, slideWidthIn, slideHeightIn])

  useAutoSave()
  useGlobalKeyboard()

  const slides = useEditor((s) => s.slides)
  const saveStatus = useEditor((s) => s.saveStatus)
  const dirtyCount = useEditor((s) => s.dirtySlideIds.size)

  return (
    <div className="flex flex-1 flex-col bg-zinc-100 dark:bg-zinc-900">
      <header className="flex items-center justify-between border-b border-zinc-200 bg-white px-5 py-2 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex items-center gap-3">
          <Link
            href="/dashboard"
            className="text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
          >
            ←
          </Link>
          <span className="text-sm font-semibold tracking-tight">
            {projectTitle}
          </span>
          <SaveIndicator status={saveStatus} dirty={dirtyCount > 0} />
        </div>
        <a
          href={`/projects/${projectId}/export`}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-blue-700"
        >
          Export PPTX
        </a>
      </header>

      <Toolbar />

      <div className="flex flex-1 overflow-hidden">
        {slides.length === 0 ? (
          <EmptyState projectId={projectId} />
        ) : (
          <>
            <SlideList projectId={projectId} />
            <SlideCanvas />
          </>
        )}
      </div>
    </div>
  )
}

function useAutoSave() {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dirtySlideIds = useEditor((s) => s.dirtySlideIds)
  const slides = useEditor((s) => s.slides)
  const markClean = useEditor((s) => s.markClean)
  const setSaveStatus = useEditor((s) => s.setSaveStatus)

  useEffect(() => {
    if (dirtySlideIds.size === 0) return
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(async () => {
      setSaveStatus('saving')
      const ids = Array.from(dirtySlideIds)
      try {
        await Promise.all(
          ids.map((id) => {
            const slide = slides.find((s) => s.id === id)
            if (!slide) return Promise.resolve()
            return saveSlide(id, slide.content).then(() => markClean(id))
          }),
        )
        setSaveStatus('idle')
      } catch (err) {
        console.error('autosave failed', err)
        setSaveStatus('error')
      }
    }, AUTOSAVE_DEBOUNCE_MS)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [dirtySlideIds, slides, markClean, setSaveStatus])
}

// Keyboard: Esc deselects, Delete removes, arrows nudge selected block.
function useGlobalKeyboard() {
  const selectedBlockId = useEditor((s) => s.selectedBlockId)
  const editingBlockId = useEditor((s) => s.editingBlockId)
  const currentSlideId = useEditor((s) => s.currentSlideId)
  const slides = useEditor((s) => s.slides)
  const selectBlock = useEditor((s) => s.selectBlock)
  const editBlock = useEditor((s) => s.editBlock)
  const updateBlock = useEditor((s) => s.updateBlock)
  const deleteBlock = useEditor((s) => s.deleteBlock)

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Don't intercept if user is typing into an input/textarea.
      const target = e.target as HTMLElement | null
      const isTextField =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable
      if (e.key === 'Escape') {
        if (editingBlockId) editBlock(null)
        else if (selectedBlockId) selectBlock(null)
        return
      }
      if (!selectedBlockId || editingBlockId || isTextField) return

      const slide = slides.find((s) => s.id === currentSlideId)
      const block = slide?.content.blocks.find((b) => b.id === selectedBlockId)
      if (!block) return

      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        deleteBlock(currentSlideId, selectedBlockId)
        selectBlock(null)
        return
      }

      const step = e.shiftKey ? NUDGE_STEP_BIG : NUDGE_STEP
      let dx = 0
      let dy = 0
      if (e.key === 'ArrowLeft') dx = -step
      else if (e.key === 'ArrowRight') dx = step
      else if (e.key === 'ArrowUp') dy = -step
      else if (e.key === 'ArrowDown') dy = step
      else return
      e.preventDefault()
      updateBlock(currentSlideId, selectedBlockId, {
        x: clamp01(block.x + dx),
        y: clamp01(block.y + dy),
      })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    selectedBlockId,
    editingBlockId,
    currentSlideId,
    slides,
    selectBlock,
    editBlock,
    updateBlock,
    deleteBlock,
  ])
}

function SaveIndicator({
  status,
  dirty,
}: {
  status: 'idle' | 'saving' | 'error'
  dirty: boolean
}) {
  const label =
    status === 'saving'
      ? 'Saving…'
      : status === 'error'
        ? 'Save failed'
        : dirty
          ? 'Unsaved'
          : 'Saved'
  const color =
    status === 'error'
      ? 'text-red-600'
      : dirty || status === 'saving'
        ? 'text-amber-600'
        : 'text-zinc-400'
  return <span className={`text-xs ${color}`}>{label}</span>
}

function Toolbar() {
  const currentSlideId = useEditor((s) => s.currentSlideId)
  const addBlock = useEditor((s) => s.addBlock)
  const slides = useEditor((s) => s.slides)
  const selectBlock = useEditor((s) => s.selectBlock)
  const disabled = !currentSlideId || slides.length === 0
  const newBox = { x: 0.1, y: 0.4, w: 0.8, h: 0.2 }

  return (
    <div className="flex items-center gap-1 border-b border-zinc-200 bg-white px-3 py-1.5 dark:border-zinc-800 dark:bg-zinc-950">
      <ToolbarButton
        disabled={disabled}
        onClick={() => {
          const id = crypto.randomUUID()
          addBlock(currentSlideId, {
            id,
            type: 'text',
            content: '',
            ...newBox,
            fontSize: 18,
          })
          selectBlock(id)
        }}
      >
        + Text
      </ToolbarButton>
      <ToolbarButton
        disabled={disabled}
        onClick={() => {
          const id = crypto.randomUUID()
          addBlock(currentSlideId, {
            id,
            type: 'image',
            url: '',
            ...newBox,
          })
          selectBlock(id)
        }}
      >
        + Image
      </ToolbarButton>
      <ToolbarButton
        disabled={disabled}
        onClick={() => {
          const tb = newTableBlock(3, 3, { x: 0.1, y: 0.3, w: 0.8, h: 0.4 })
          addBlock(currentSlideId, tb)
          selectBlock(tb.id)
        }}
      >
        + Table
      </ToolbarButton>
    </div>
  )
}

function ToolbarButton({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 dark:text-zinc-200 dark:hover:bg-zinc-800"
    >
      {children}
    </button>
  )
}

function EmptyState({ projectId }: { projectId: string }) {
  const [pending, startTransition] = useTransition()
  const addSlideLocal = useEditor((s) => s.addSlideLocal)
  return (
    <div className="flex flex-1 items-center justify-center">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const slide = await addSlide(projectId)
            addSlideLocal(slide)
          })
        }
        className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {pending ? 'Creating…' : 'Add first slide'}
      </button>
    </div>
  )
}

function SlideList({ projectId }: { projectId: string }) {
  const slides = useEditor((s) => s.slides)
  const currentSlideId = useEditor((s) => s.currentSlideId)
  const setCurrentSlide = useEditor((s) => s.setCurrentSlide)
  const addSlideLocal = useEditor((s) => s.addSlideLocal)
  const deleteSlideLocal = useEditor((s) => s.deleteSlideLocal)
  const moveSlide = useEditor((s) => s.moveSlide)
  const [pending, startTransition] = useTransition()

  const persistOrder = () => {
    const ids = useEditor.getState().slides.map((s) => s.id)
    startTransition(async () => {
      await reorderSlides(projectId, ids)
    })
  }

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex-1 overflow-y-auto p-3">
        <ul className="flex flex-col gap-2">
          {slides.map((slide, idx) => {
            const active = slide.id === currentSlideId
            return (
              <li key={slide.id} className="group flex items-start gap-2">
                <span className="w-5 pt-1 text-right text-xs font-medium text-zinc-400">
                  {idx + 1}
                </span>
                <div className="relative flex-1">
                  <button
                    type="button"
                    onClick={() => setCurrentSlide(slide.id)}
                    className="block w-full"
                    aria-label={`Slide ${idx + 1}`}
                  >
                    <SlideThumbnail slide={slide} active={active} />
                  </button>
                  <div className="absolute right-1 top-1 hidden gap-0.5 rounded bg-white/90 p-0.5 shadow group-hover:flex dark:bg-zinc-900/90">
                    <ThumbAction
                      label="Move up"
                      disabled={idx === 0}
                      onClick={() => {
                        moveSlide(idx, idx - 1)
                        persistOrder()
                      }}
                    >
                      ↑
                    </ThumbAction>
                    <ThumbAction
                      label="Move down"
                      disabled={idx === slides.length - 1}
                      onClick={() => {
                        moveSlide(idx, idx + 1)
                        persistOrder()
                      }}
                    >
                      ↓
                    </ThumbAction>
                    <ThumbAction
                      label="Delete"
                      onClick={() =>
                        startTransition(async () => {
                          await deleteSlide(projectId, slide.id)
                          deleteSlideLocal(slide.id)
                        })
                      }
                    >
                      <span className="text-red-600">×</span>
                    </ThumbAction>
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      </div>
      <div className="border-t border-zinc-200 p-3 dark:border-zinc-800">
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const slide = await addSlide(projectId)
              addSlideLocal(slide)
            })
          }
          className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
        >
          + New slide
        </button>
      </div>
    </aside>
  )
}

function ThumbAction({
  children,
  onClick,
  disabled,
  label,
}: {
  children: React.ReactNode
  onClick: () => void
  disabled?: boolean
  label: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="rounded px-1 text-xs text-zinc-600 hover:bg-zinc-100 disabled:opacity-30 dark:text-zinc-300 dark:hover:bg-zinc-800"
    >
      {children}
    </button>
  )
}

function SlideThumbnail({
  slide,
  active,
}: {
  slide: SlideData
  active: boolean
}) {
  const slideWidthIn = useEditor((s) => s.slideWidthIn)
  const slideHeightIn = useEditor((s) => s.slideHeightIn)
  const refH = (SLIDE_REF_W * slideHeightIn) / slideWidthIn
  return (
    <div
      className={`relative w-full overflow-hidden rounded-sm border-2 ${
        active
          ? 'border-blue-500 shadow-sm'
          : 'border-zinc-200 hover:border-zinc-300 dark:border-zinc-700 dark:hover:border-zinc-600'
      }`}
      style={{
        aspectRatio: `${slideWidthIn} / ${slideHeightIn}`,
        backgroundColor: slide.content.background ?? undefined,
      }}
    >
      <div
        className="absolute left-0 top-0 origin-top-left"
        style={{
          width: SLIDE_REF_W,
          height: refH,
          transform: `scale(${THUMB_SCALE})`,
        }}
      >
        <SlideRender slide={slide} />
      </div>
    </div>
  )
}

function SlideRender({ slide }: { slide: SlideData }) {
  if (slide.content.blocks.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-2xl text-zinc-300">
        Empty
      </div>
    )
  }
  return (
    <div className="relative h-full w-full">
      {slide.content.blocks.map((block) => (
        <PositionedBlock key={block.id} block={block} />
      ))}
    </div>
  )
}

function SlideCanvas() {
  const slide = useEditor((s) =>
    s.slides.find((sl) => sl.id === s.currentSlideId),
  )
  const slideWidthIn = useEditor((s) => s.slideWidthIn)
  const slideHeightIn = useEditor((s) => s.slideHeightIn)
  const selectBlock = useEditor((s) => s.selectBlock)
  const selectedBlockId = useEditor((s) => s.selectedBlockId)
  const canvasRef = useRef<HTMLDivElement>(null)

  if (!slide) return null

  const selectedBlock = selectedBlockId
    ? (slide.content.blocks.find((b) => b.id === selectedBlockId) ?? null)
    : null

  return (
    <section
      className="relative flex flex-1 items-start justify-center overflow-auto p-10"
      onPointerDown={(e) => {
        // Click on the gray surround = deselect.
        if (e.target === e.currentTarget) selectBlock(null)
      }}
    >
      <div
        ref={canvasRef}
        className="relative w-full max-w-5xl rounded-md shadow-xl ring-1 ring-zinc-200 dark:ring-zinc-800"
        style={{
          aspectRatio: `${slideWidthIn} / ${slideHeightIn}`,
          backgroundColor: slide.content.background ?? '#ffffff',
        }}
        onPointerDown={(e) => {
          // Click on empty canvas (not a block) = deselect.
          if (e.target === e.currentTarget) selectBlock(null)
        }}
      >
        {slide.content.blocks.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-zinc-400">
            Empty slide. Use the toolbar to add a block.
          </div>
        ) : (
          slide.content.blocks.map((block) => (
            <EditableBlock
              key={block.id}
              slideId={slide.id}
              block={block}
              canvasRef={canvasRef}
            />
          ))
        )}
        <SnapGuides />
      </div>

      {selectedBlock && selectedBlock.type === 'text' && (
        <FloatingTextToolbar
          slideId={slide.id}
          block={selectedBlock as TextBlock}
        />
      )}
      {selectedBlock && selectedBlock.type === 'table' && (
        <FloatingTableToolbar
          slideId={slide.id}
          block={selectedBlock as TableBlock}
        />
      )}
    </section>
  )
}

function FloatingTableToolbar({
  slideId,
  block,
}: {
  slideId: string
  block: TableBlock
}) {
  const updateBlock = useEditor((s) => s.updateBlock)

  const newCell = (): TableCell => ({
    id: crypto.randomUUID(),
    content: '',
  })

  const addRow = (afterIdx: number) => {
    const row: TableCell[] = Array.from({ length: block.cols }, newCell)
    const cells = [...block.cells]
    cells.splice(afterIdx + 1, 0, row)
    const rowHeights = block.rowHeights
      ? equalize(block.rowHeights.length + 1)
      : undefined
    updateBlock(slideId, block.id, {
      cells,
      rows: block.rows + 1,
      rowHeights,
    } as Partial<TableBlock>)
  }

  const addCol = (afterIdx: number) => {
    const cells = block.cells.map((row) => {
      const next = row.slice()
      next.splice(afterIdx + 1, 0, newCell())
      return next
    })
    const colWidths = block.colWidths
      ? equalize(block.colWidths.length + 1)
      : undefined
    updateBlock(slideId, block.id, {
      cells,
      cols: block.cols + 1,
      colWidths,
    } as Partial<TableBlock>)
  }

  const removeRow = () => {
    if (block.rows <= 1) return
    const cells = block.cells.slice(0, -1)
    const rowHeights = block.rowHeights ? equalize(cells.length) : undefined
    updateBlock(slideId, block.id, {
      cells,
      rows: block.rows - 1,
      rowHeights,
    } as Partial<TableBlock>)
  }

  const removeCol = () => {
    if (block.cols <= 1) return
    const cells = block.cells.map((row) => row.slice(0, -1))
    const colWidths = block.colWidths
      ? equalize(block.cols - 1)
      : undefined
    updateBlock(slideId, block.id, {
      cells,
      cols: block.cols - 1,
      colWidths,
    } as Partial<TableBlock>)
  }

  return (
    <div className="pointer-events-auto absolute left-1/2 top-3 z-30 flex -translate-x-1/2 items-center gap-1 rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs shadow-md dark:border-zinc-800 dark:bg-zinc-900">
      <button
        type="button"
        onClick={() => addRow(block.rows - 1)}
        className="rounded px-2 py-0.5 hover:bg-zinc-100 dark:hover:bg-zinc-800"
      >
        + Row
      </button>
      <button
        type="button"
        onClick={removeRow}
        disabled={block.rows <= 1}
        className="rounded px-2 py-0.5 hover:bg-zinc-100 disabled:opacity-40 dark:hover:bg-zinc-800"
      >
        − Row
      </button>
      <span className="mx-1 h-4 w-px bg-zinc-200 dark:bg-zinc-700" />
      <button
        type="button"
        onClick={() => addCol(block.cols - 1)}
        className="rounded px-2 py-0.5 hover:bg-zinc-100 dark:hover:bg-zinc-800"
      >
        + Col
      </button>
      <button
        type="button"
        onClick={removeCol}
        disabled={block.cols <= 1}
        className="rounded px-2 py-0.5 hover:bg-zinc-100 disabled:opacity-40 dark:hover:bg-zinc-800"
      >
        − Col
      </button>
    </div>
  )
}

function equalize(n: number): number[] {
  return Array.from({ length: n }, () => 1 / n)
}

function SnapGuides() {
  const guidesV = useEditor((s) => s.activeGuidesV)
  const guidesH = useEditor((s) => s.activeGuidesH)
  if (guidesV.length === 0 && guidesH.length === 0) return null
  return (
    <>
      {guidesV.map((x, i) => (
        <div
          key={`v-${i}-${x}`}
          className="pointer-events-none absolute top-0 z-30 h-full w-px bg-pink-500"
          style={{ left: `${x * 100}%` }}
        />
      ))}
      {guidesH.map((y, i) => (
        <div
          key={`h-${i}-${y}`}
          className="pointer-events-none absolute left-0 z-30 h-px w-full bg-pink-500"
          style={{ top: `${y * 100}%` }}
        />
      ))}
    </>
  )
}

function FloatingTextToolbar({
  slideId,
  block,
}: {
  slideId: string
  block: TextBlock
}) {
  const updateBlock = useEditor((s) => s.updateBlock)
  // Toolbar formatting promotes to whole-block — drop any per-run override.
  const patch = (p: Partial<TextBlock>) =>
    updateBlock(slideId, block.id, { ...p, runs: undefined } as Partial<TextBlock>)

  return (
    <div className="pointer-events-auto absolute left-1/2 top-3 z-30 flex -translate-x-1/2 items-center gap-1 rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs shadow-md dark:border-zinc-800 dark:bg-zinc-900">
      <button
        type="button"
        onClick={() => patch({ fontSize: Math.max(6, (block.fontSize ?? 18) - 2) })}
        className="rounded px-1.5 py-0.5 hover:bg-zinc-100 dark:hover:bg-zinc-800"
        aria-label="Decrease font size"
      >
        A−
      </button>
      <span className="w-8 text-center tabular-nums">
        {block.fontSize ?? 18}
      </span>
      <button
        type="button"
        onClick={() => patch({ fontSize: Math.min(120, (block.fontSize ?? 18) + 2) })}
        className="rounded px-1.5 py-0.5 hover:bg-zinc-100 dark:hover:bg-zinc-800"
        aria-label="Increase font size"
      >
        A+
      </button>
      <span className="mx-1 h-4 w-px bg-zinc-200 dark:bg-zinc-700" />
      <ToggleBtn active={!!block.bold} onClick={() => patch({ bold: !block.bold })}>
        <span className="font-bold">B</span>
      </ToggleBtn>
      <ToggleBtn
        active={!!block.italic}
        onClick={() => patch({ italic: !block.italic })}
      >
        <span className="italic">I</span>
      </ToggleBtn>
      <span className="mx-1 h-4 w-px bg-zinc-200 dark:bg-zinc-700" />
      <input
        type="color"
        value={block.color ?? '#111111'}
        onChange={(e) => patch({ color: e.target.value })}
        className="h-5 w-6 cursor-pointer rounded border border-zinc-200 bg-transparent dark:border-zinc-700"
        aria-label="Text color"
      />
      <span className="mx-1 h-4 w-px bg-zinc-200 dark:bg-zinc-700" />
      <ToggleBtn
        active={block.align === 'left' || !block.align}
        onClick={() => patch({ align: 'left' })}
      >
        L
      </ToggleBtn>
      <ToggleBtn
        active={block.align === 'center'}
        onClick={() => patch({ align: 'center' })}
      >
        C
      </ToggleBtn>
      <ToggleBtn
        active={block.align === 'right'}
        onClick={() => patch({ align: 'right' })}
      >
        R
      </ToggleBtn>
    </div>
  )
}

function ToggleBtn({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded px-1.5 py-0.5 ${
        active
          ? 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-200'
          : 'hover:bg-zinc-100 dark:hover:bg-zinc-800'
      }`}
    >
      {children}
    </button>
  )
}

function EditableBlock({
  slideId,
  block,
  canvasRef,
}: {
  slideId: string
  block: Block
  canvasRef: React.RefObject<HTMLDivElement | null>
}) {
  const selected = useEditor((s) => s.selectedBlockId === block.id)
  const editing = useEditor((s) => s.editingBlockId === block.id)
  const selectBlock = useEditor((s) => s.selectBlock)
  const editBlock = useEditor((s) => s.editBlock)
  const updateBlock = useEditor((s) => s.updateBlock)

  const beginDrag = useDragMove({
    slideId,
    canvasRef,
    block,
    onChange: (patch) => updateBlock(slideId, block.id, patch),
  })

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (editing) return
    e.stopPropagation()
    selectBlock(block.id)
    beginDrag(e)
  }

  const onDoubleClick = (e: React.MouseEvent) => {
    if (block.type === 'text') {
      e.stopPropagation()
      editBlock(block.id)
    }
  }

  return (
    <div
      style={blockBoxStyle(block)}
      className={`group ${selected ? 'z-20' : 'z-10'} ${
        editing ? 'cursor-text' : 'cursor-move'
      }`}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
    >
      <div
        className={`relative h-full w-full overflow-hidden rounded-[1px] ${
          selected
            ? 'outline outline-2 outline-blue-500'
            : 'outline outline-1 outline-transparent group-hover:outline-blue-300'
        }`}
      >
        <BlockBody
          slideId={slideId}
          block={block}
          editing={editing}
          onCommitEdit={() => editBlock(null)}
        />
      </div>
      {selected && !editing && (
        <ResizeHandles
          slideId={slideId}
          canvasRef={canvasRef}
          block={block}
          onChange={(patch) => updateBlock(slideId, block.id, patch)}
        />
      )}
    </div>
  )
}

function BlockBody({
  slideId,
  block,
  editing,
  onCommitEdit,
}: {
  slideId: string
  block: Block
  editing: boolean
  onCommitEdit: () => void
}) {
  const updateBlock = useEditor((s) => s.updateBlock)

  if (block.type === 'text') {
    if (editing) {
      return (
        <textarea
          autoFocus
          value={block.content}
          onChange={(e) =>
            updateBlock(slideId, block.id, {
              content: e.target.value,
              // Editing collapses any rich-text runs to plain content.
              runs: undefined,
            } as Partial<TextBlock>)
          }
          onBlur={onCommitEdit}
          onPointerDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          placeholder="Type text…"
          className="h-full w-full resize-none whitespace-pre-wrap break-words bg-transparent leading-tight focus:outline-none"
          style={{ ...textStyle(block), overflow: 'hidden' }}
        />
      )
    }
    return (
      <div
        className="pointer-events-none h-full w-full select-none whitespace-pre-wrap break-words leading-tight"
        style={{ ...textStyle(block), overflow: 'hidden' }}
      >
        {block.runs && block.runs.length > 0 ? (
          <RunsView runs={block.runs} />
        ) : block.content ? (
          block.content
        ) : (
          <span className="text-zinc-300">Double-click to edit</span>
        )}
      </div>
    )
  }

  if (block.type === 'image') {
    if (block.url) {
      return (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={block.url}
          alt={block.alt ?? ''}
          draggable={false}
          className="pointer-events-none h-full w-full object-contain"
        />
      )
    }
    return (
      <ImageUrlInput
        block={block}
        onChange={(patch) =>
          updateBlock(slideId, block.id, patch as Partial<ImageBlock>)
        }
      />
    )
  }

  if (block.type === 'line') {
    return (
      <div
        className="h-full w-full"
        style={{ backgroundColor: block.color ?? '#000000' }}
      />
    )
  }

  // Table
  return (
    <TableBody
      slideId={slideId}
      block={block}
      editing={editing}
      onCommitEdit={onCommitEdit}
    />
  )
}

function TableBody({
  slideId,
  block,
  editing,
  onCommitEdit,
}: {
  slideId: string
  block: TableBlock
  editing: boolean
  onCommitEdit: () => void
}) {
  const updateBlock = useEditor((s) => s.updateBlock)
  const editingCellId = useEditor((s) => s.editingCellId)
  const setEditingCell = useEditor((s) => s.setEditingCell)

  // Editing a cell collapses its rich-text runs to plain content.
  const setCell = (rowIdx: number, colIdx: number, content: string) => {
    const next = block.cells.map((row) => row.slice())
    next[rowIdx] = next[rowIdx].slice()
    next[rowIdx][colIdx] = {
      ...next[rowIdx][colIdx],
      content,
      runs: undefined,
    }
    updateBlock(slideId, block.id, {
      cells: next,
    } as Partial<TableBlock>)
  }

  // Same table-level styling as the read-mode TableContent in @/components/slide.
  const tableStyle: CSSProperties = {
    fontSize: block.fontSize ? `${block.fontSize}pt` : undefined,
    fontFamily: block.fontFamily
      ? `"${block.fontFamily}", "Malgun Gothic", "Apple SD Gothic Neo", sans-serif`
      : undefined,
    color: block.color,
    fontWeight: block.bold ? 700 : undefined,
  }

  return (
    <table
      className="h-full w-full table-fixed border-collapse"
      style={tableStyle}
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
            {row.map((cell, j) => {
              const isEditingCell = editing && editingCellId === cell.id
              return (
                <td
                  key={cell.id}
                  onPointerDown={(e) => {
                    if (editing) e.stopPropagation()
                  }}
                  onDoubleClick={(e) => {
                    e.stopPropagation()
                    setEditingCell(cell.id)
                  }}
                  className="overflow-hidden border border-zinc-300 align-top dark:border-zinc-700"
                >
                  {isEditingCell ? (
                    <textarea
                      autoFocus
                      value={cell.content}
                      onChange={(e) => setCell(i, j, e.target.value)}
                      onBlur={() => {
                        setEditingCell(null)
                        onCommitEdit()
                      }}
                      onPointerDown={(e) => e.stopPropagation()}
                      onDoubleClick={(e) => e.stopPropagation()}
                      className="h-full w-full resize-none bg-transparent px-1 leading-tight focus:outline-none"
                      style={{ overflow: 'hidden' }}
                    />
                  ) : (
                    <div className="pointer-events-none h-full w-full select-none whitespace-pre-wrap break-words px-1 leading-tight">
                      {cell.runs && cell.runs.length > 0 ? (
                        <RunsView runs={cell.runs} />
                      ) : cell.content ? (
                        cell.content
                      ) : (
                        <span className="text-zinc-300">·</span>
                      )}
                    </div>
                  )}
                </td>
              )
            })}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function ImageUrlInput({
  block,
  onChange,
}: {
  block: ImageBlock
  onChange: (patch: Partial<ImageBlock>) => void
}) {
  return (
    <div className="flex h-full w-full items-center justify-center p-1">
      <input
        type="url"
        value={block.url}
        onChange={(e) => onChange({ url: e.target.value })}
        onPointerDown={(e) => e.stopPropagation()}
        placeholder="Image URL"
        className="w-full rounded border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
      />
    </div>
  )
}

// Reusable drag-move hook. Returns a pointerdown handler that captures the
// pointer and drives x/y updates while the pointer moves. Snaps the block's
// edges/centers to siblings + slide edges/centers, and emits guide lines.
function useDragMove({
  slideId,
  canvasRef,
  block,
  onChange,
}: {
  slideId: string
  canvasRef: React.RefObject<HTMLDivElement | null>
  block: Block
  onChange: (patch: Partial<Block>) => void
}) {
  const setActiveGuides = useEditor((s) => s.setActiveGuides)

  const start = useRef<{
    px: number
    py: number
    bx: number
    by: number
    bw: number
    bh: number
    cw: number
    ch: number
    cands: { v: number[]; h: number[] }
  } | null>(null)

  const onMove = useCallback(
    (e: globalThis.PointerEvent) => {
      const s = start.current
      if (!s) return
      const rawDx = (e.clientX - s.px) / s.cw
      const rawDy = (e.clientY - s.py) / s.ch
      let nx = clamp01(s.bx + rawDx)
      let ny = clamp01(s.by + rawDy)

      const myV = [nx, nx + s.bw / 2, nx + s.bw]
      const myH = [ny, ny + s.bh / 2, ny + s.bh]
      const dv = bestDelta(myV, s.cands.v, SNAP_THRESHOLD)
      const dh = bestDelta(myH, s.cands.h, SNAP_THRESHOLD)
      if (dv !== null) nx = clamp01(nx + dv)
      if (dh !== null) ny = clamp01(ny + dh)
      const guidesV = dv !== null ? matchingGuides([nx, nx + s.bw / 2, nx + s.bw], 0, s.cands.v) : []
      const guidesH = dh !== null ? matchingGuides([ny, ny + s.bh / 2, ny + s.bh], 0, s.cands.h) : []
      setActiveGuides(guidesV, guidesH)
      onChange({ x: nx, y: ny })
    },
    [onChange, setActiveGuides],
  )

  const onUp = useCallback(() => {
    start.current = null
    setActiveGuides([], [])
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
  }, [onMove, setActiveGuides])

  return useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      start.current = {
        px: e.clientX,
        py: e.clientY,
        bx: block.x,
        by: block.y,
        bw: block.w,
        bh: block.h,
        cw: rect.width,
        ch: rect.height,
        cands: snapCandidates(siblingBoxes(slideId, block.id)),
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [canvasRef, slideId, block.id, block.x, block.y, block.w, block.h, onMove, onUp],
  )
}

function ResizeHandles({
  slideId,
  canvasRef,
  block,
  onChange,
}: {
  slideId: string
  canvasRef: React.RefObject<HTMLDivElement | null>
  block: Block
  onChange: (patch: Partial<Block>) => void
}) {
  const dirs: ResizeDir[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
  return (
    <>
      {dirs.map((d) => (
        <Handle
          key={d}
          dir={d}
          slideId={slideId}
          canvasRef={canvasRef}
          block={block}
          onChange={onChange}
        />
      ))}
    </>
  )
}

const HANDLE_POS: Record<ResizeDir, string> = {
  nw: 'top-0 left-0 -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize',
  n: 'top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 cursor-ns-resize',
  ne: 'top-0 right-0 translate-x-1/2 -translate-y-1/2 cursor-nesw-resize',
  e: 'top-1/2 right-0 translate-x-1/2 -translate-y-1/2 cursor-ew-resize',
  se: 'bottom-0 right-0 translate-x-1/2 translate-y-1/2 cursor-nwse-resize',
  s: 'bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2 cursor-ns-resize',
  sw: 'bottom-0 left-0 -translate-x-1/2 translate-y-1/2 cursor-nesw-resize',
  w: 'top-1/2 left-0 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize',
}

function Handle({
  dir,
  slideId,
  canvasRef,
  block,
  onChange,
}: {
  dir: ResizeDir
  slideId: string
  canvasRef: React.RefObject<HTMLDivElement | null>
  block: Block
  onChange: (patch: Partial<Block>) => void
}) {
  const setActiveGuides = useEditor((s) => s.setActiveGuides)

  const start = useRef<{
    px: number
    py: number
    x: number
    y: number
    w: number
    h: number
    cw: number
    ch: number
    cands: { v: number[]; h: number[] }
  } | null>(null)

  const onMove = useCallback(
    (e: globalThis.PointerEvent) => {
      const s = start.current
      if (!s) return
      const dx = (e.clientX - s.px) / s.cw
      const dy = (e.clientY - s.py) / s.ch
      let x = s.x
      let y = s.y
      let w = s.w
      let h = s.h
      if (dir.includes('e')) w = Math.max(MIN_BLOCK_FRAC, s.w + dx)
      if (dir.includes('w')) {
        const nx = clamp01(s.x + dx)
        w = Math.max(MIN_BLOCK_FRAC, s.w - (nx - s.x))
        x = nx
      }
      if (dir.includes('s')) h = Math.max(MIN_BLOCK_FRAC, s.h + dy)
      if (dir.includes('n')) {
        const ny = clamp01(s.y + dy)
        h = Math.max(MIN_BLOCK_FRAC, s.h - (ny - s.y))
        y = ny
      }
      if (x + w > 1) w = 1 - x
      if (y + h > 1) h = 1 - y

      // Snap the moving edge to candidates. Only the dragged edge snaps;
      // the opposite edge stays put.
      const myV: number[] = []
      const myH: number[] = []
      if (dir.includes('w')) myV.push(x)
      if (dir.includes('e')) myV.push(x + w)
      if (dir.includes('n')) myH.push(y)
      if (dir.includes('s')) myH.push(y + h)

      const dv = myV.length > 0 ? bestDelta(myV, s.cands.v, SNAP_THRESHOLD) : null
      const dh = myH.length > 0 ? bestDelta(myH, s.cands.h, SNAP_THRESHOLD) : null
      if (dv !== null) {
        if (dir.includes('w')) {
          x = clamp01(x + dv)
          w = Math.max(MIN_BLOCK_FRAC, s.w - (x - s.x))
        } else if (dir.includes('e')) {
          w = Math.max(MIN_BLOCK_FRAC, w + dv)
        }
      }
      if (dh !== null) {
        if (dir.includes('n')) {
          y = clamp01(y + dh)
          h = Math.max(MIN_BLOCK_FRAC, s.h - (y - s.y))
        } else if (dir.includes('s')) {
          h = Math.max(MIN_BLOCK_FRAC, h + dh)
        }
      }

      const finalV: number[] = []
      const finalH: number[] = []
      if (dir.includes('w')) finalV.push(x)
      if (dir.includes('e')) finalV.push(x + w)
      if (dir.includes('n')) finalH.push(y)
      if (dir.includes('s')) finalH.push(y + h)
      const guidesV = dv !== null ? matchingGuides(finalV, 0, s.cands.v) : []
      const guidesH = dh !== null ? matchingGuides(finalH, 0, s.cands.h) : []
      setActiveGuides(guidesV, guidesH)

      onChange({ x, y, w, h })
    },
    [dir, onChange, setActiveGuides],
  )

  const onUp = useCallback(() => {
    start.current = null
    setActiveGuides([], [])
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
  }, [onMove, setActiveGuides])

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.stopPropagation()
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    start.current = {
      px: e.clientX,
      py: e.clientY,
      x: block.x,
      y: block.y,
      w: block.w,
      h: block.h,
      cw: rect.width,
      ch: rect.height,
      cands: snapCandidates(siblingBoxes(slideId, block.id)),
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return (
    <div
      onPointerDown={onPointerDown}
      className={`absolute h-2.5 w-2.5 rounded-sm border border-blue-500 bg-white ${HANDLE_POS[dir]}`}
      aria-hidden
    />
  )
}
