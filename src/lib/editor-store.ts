import { create } from 'zustand'
import type { Block, SlideData } from './slide-types'

export type SaveStatus = 'idle' | 'saving' | 'error'

type EditorState = {
  projectId: string
  slides: SlideData[]
  currentSlideId: string
  dirtySlideIds: Set<string>
  saveStatus: SaveStatus
  slideWidthIn: number
  slideHeightIn: number

  // Selection: a block can be "selected" (handles + toolbar visible) and/or
  // "editing" (text body is a focused textarea). Selecting a different block
  // exits edit mode automatically.
  selectedBlockId: string | null
  editingBlockId: string | null
  // For TableBlock: which cell is currently being edited (cell.id).
  editingCellId: string | null

  // Active alignment guides (positions in slide fractions). Set during
  // drag/resize, cleared on pointer-up.
  activeGuidesV: number[]
  activeGuidesH: number[]

  init: (
    projectId: string,
    slides: SlideData[],
    slideWidthIn: number,
    slideHeightIn: number,
  ) => void
  setCurrentSlide: (id: string) => void

  selectBlock: (blockId: string | null) => void
  editBlock: (blockId: string | null) => void
  setEditingCell: (cellId: string | null) => void

  setActiveGuides: (v: number[], h: number[]) => void

  updateBlock: (
    slideId: string,
    blockId: string,
    patch: Partial<Block>,
  ) => void
  addBlock: (slideId: string, block: Block) => void
  deleteBlock: (slideId: string, blockId: string) => void

  addSlideLocal: (slide: SlideData) => void
  deleteSlideLocal: (slideId: string) => void
  moveSlide: (fromIdx: number, toIdx: number) => void

  markClean: (slideId: string) => void
  setSaveStatus: (status: SaveStatus) => void
}

const mapBlocks = (slides: SlideData[], slideId: string, fn: (b: Block) => Block) =>
  slides.map((s) =>
    s.id === slideId
      ? { ...s, content: { blocks: s.content.blocks.map(fn) } }
      : s,
  )

export const useEditor = create<EditorState>((set) => ({
  projectId: '',
  slides: [],
  currentSlideId: '',
  dirtySlideIds: new Set<string>(),
  saveStatus: 'idle',
  slideWidthIn: 13.333,
  slideHeightIn: 7.5,
  selectedBlockId: null,
  editingBlockId: null,
  editingCellId: null,
  activeGuidesV: [],
  activeGuidesH: [],

  init: (projectId, slides, slideWidthIn, slideHeightIn) =>
    set({
      projectId,
      slides,
      currentSlideId: slides[0]?.id ?? '',
      dirtySlideIds: new Set(),
      saveStatus: 'idle',
      slideWidthIn,
      slideHeightIn,
      selectedBlockId: null,
      editingBlockId: null,
      editingCellId: null,
      activeGuidesV: [],
      activeGuidesH: [],
    }),

  setCurrentSlide: (id) =>
    set({ currentSlideId: id, selectedBlockId: null, editingBlockId: null }),

  selectBlock: (blockId) =>
    set((state) => ({
      selectedBlockId: blockId,
      // Selecting a different block exits any ongoing edit.
      editingBlockId:
        state.editingBlockId && state.editingBlockId !== blockId
          ? null
          : state.editingBlockId,
    })),

  editBlock: (blockId) =>
    set({
      editingBlockId: blockId,
      selectedBlockId: blockId,
      editingCellId: null,
    }),

  setEditingCell: (cellId) =>
    set((state) => ({
      editingCellId: cellId,
      editingBlockId: cellId
        ? (state.editingBlockId ?? state.selectedBlockId)
        : state.editingBlockId,
    })),

  setActiveGuides: (v, h) => set({ activeGuidesV: v, activeGuidesH: h }),

  updateBlock: (slideId, blockId, patch) =>
    set((state) => ({
      slides: mapBlocks(state.slides, slideId, (b) =>
        b.id === blockId ? ({ ...b, ...patch } as Block) : b,
      ),
      dirtySlideIds: new Set(state.dirtySlideIds).add(slideId),
    })),

  addBlock: (slideId, block) =>
    set((state) => ({
      slides: state.slides.map((s) =>
        s.id === slideId
          ? { ...s, content: { blocks: [...s.content.blocks, block] } }
          : s,
      ),
      dirtySlideIds: new Set(state.dirtySlideIds).add(slideId),
    })),

  deleteBlock: (slideId, blockId) =>
    set((state) => ({
      slides: state.slides.map((s) =>
        s.id === slideId
          ? {
              ...s,
              content: {
                blocks: s.content.blocks.filter((b) => b.id !== blockId),
              },
            }
          : s,
      ),
      dirtySlideIds: new Set(state.dirtySlideIds).add(slideId),
    })),

  addSlideLocal: (slide) =>
    set((state) => ({
      slides: [...state.slides, slide],
      currentSlideId: slide.id,
    })),

  deleteSlideLocal: (slideId) =>
    set((state) => {
      const remaining = state.slides.filter((s) => s.id !== slideId)
      const nextCurrent =
        state.currentSlideId === slideId
          ? remaining[0]?.id ?? ''
          : state.currentSlideId
      const next = new Set(state.dirtySlideIds)
      next.delete(slideId)
      return {
        slides: remaining,
        currentSlideId: nextCurrent,
        dirtySlideIds: next,
      }
    }),

  moveSlide: (fromIdx, toIdx) =>
    set((state) => {
      if (
        fromIdx === toIdx ||
        fromIdx < 0 ||
        toIdx < 0 ||
        fromIdx >= state.slides.length ||
        toIdx >= state.slides.length
      ) {
        return {}
      }
      const next = [...state.slides]
      const [moved] = next.splice(fromIdx, 1)
      next.splice(toIdx, 0, moved)
      return { slides: next.map((s, i) => ({ ...s, order: i })) }
    }),

  markClean: (slideId) =>
    set((state) => {
      const next = new Set(state.dirtySlideIds)
      next.delete(slideId)
      return { dirtySlideIds: next }
    }),

  setSaveStatus: (saveStatus) => set({ saveStatus }),
}))
