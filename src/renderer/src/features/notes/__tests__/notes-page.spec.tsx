import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteMeta } from '@shared/notes'
import { NotesPage } from '@renderer/features/notes/NotesPage'
import {
  NOTE_AUTOSAVE_MS,
  NOTE_SEARCH_MS,
  resetNotesStore,
  useNotesStore
} from '@renderer/features/notes/notes-store'
import {
  clearKyclawBridge,
  installKyclawBridge,
  type KyclawBridgeStubs
} from '@renderer/__tests__/kyclaw-bridge'

const NOTE_A: NoteMeta = {
  id: '11111111-1111-4111-8111-111111111111',
  title: '周会纪要',
  createdAt: '2026-10-17T08:00:00.000Z',
  updatedAt: '2026-10-17T09:30:00.000Z',
  pinned: false,
  excerpt: '决定下周上线。'
}

const NOTE_B: NoteMeta = {
  id: '22222222-2222-4222-8222-222222222222',
  title: '资料整理',
  createdAt: '2026-10-16T08:00:00.000Z',
  updatedAt: '2026-10-16T10:00:00.000Z',
  pinned: true,
  excerpt: '待补充。'
}

const NOTE_A_BODY = '# 周会纪要\n\n决定 **下周上线**。'
let bridge: KyclawBridgeStubs

function mockMatchMedia(narrow: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: narrow && query.includes('max-width'),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => false)
    }))
  })
}

/** 直接预置 store（跳过 init 的列表/加载轮，专测编辑器交互） */
function seedStore(patch: Record<string, unknown> = {}): void {
  useNotesStore.setState({
    initialized: true,
    notes: [NOTE_A, NOTE_B],
    selectedId: NOTE_A.id,
    title: NOTE_A.title,
    body: NOTE_A_BODY,
    dirty: false,
    mode: 'edit',
    saveState: 'idle',
    savedAt: NOTE_A.updatedAt,
    saveError: null,
    ...patch
  })
}

function flush(): Promise<void> {
  return act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  resetNotesStore()
  bridge = installKyclawBridge()
  bridge.notes.list.mockResolvedValue({ notes: [NOTE_A, NOTE_B] })
  bridge.notes.get.mockResolvedValue({ text: NOTE_A_BODY })
  mockMatchMedia(false)
})

afterEach(() => {
  cleanup()
  resetNotesStore()
  clearKyclawBridge()
  vi.useRealTimers()
})

describe('列表 / 选中 / 空态', () => {
  it('加载列表并自动选中第一篇：左列行 + 右区标题/正文', async () => {
    render(<NotesPage />)

    expect(await screen.findByTestId(`note-row-${NOTE_A.id}`)).toBeInTheDocument()
    expect(screen.getByTestId(`note-row-${NOTE_B.id}`)).toBeInTheDocument()
    // 置顶优先：NOTE_B 是 pinned，init 自动选中它（与主进程排序同口径）
    await waitFor(() => expect(screen.getByTestId('note-title')).toHaveValue('资料整理'))
    expect(bridge.notes.get).toHaveBeenCalledWith(NOTE_B.id)
    expect(screen.getByTestId('note-body')).toHaveValue(NOTE_A_BODY)
    expect(screen.getByTestId('notes-open-folder')).toBeInTheDocument()
    expect(screen.getByTestId(`note-pin-${NOTE_B.id}`)).toHaveAttribute('aria-pressed', 'true')
  })

  it('没有笔记：空态是一句衬线标题 + 说明 + 实物动作，不放插画', async () => {
    bridge.notes.list.mockResolvedValue({ notes: [] })
    render(<NotesPage />)

    const empty = await screen.findByTestId('notes-empty')
    expect(empty).toHaveTextContent('写下第一篇笔记')
    expect(empty).toHaveTextContent('本机上的 Markdown 文件')
    expect(empty.querySelector('img,svg[role="img"]')).toBeNull()
    expect(screen.getByTestId('notes-empty-create')).toBeInTheDocument()
  })

  it('选中第二篇：get 带 id、右区换成第二篇正文', async () => {
    bridge.notes.get.mockResolvedValue({ text: '第二篇正文' })
    render(<NotesPage />)
    await screen.findByTestId(`note-row-${NOTE_A.id}`)

    fireEvent.click(screen.getByTestId(`note-row-${NOTE_B.id}`))
    await waitFor(() => expect(screen.getByTestId('note-title')).toHaveValue('资料整理'))
    expect(bridge.notes.get).toHaveBeenCalledWith(NOTE_B.id)
    expect(screen.getByTestId('note-body')).toHaveValue('第二篇正文')
  })

  it('新建笔记：create → 重新拉列表 → 选中新笔记', async () => {
    const created: NoteMeta = {
      id: '33333333-3333-4333-8333-333333333333',
      title: '未命名笔记',
      createdAt: '2026-10-18T00:00:00.000Z',
      updatedAt: '2026-10-18T00:00:00.000Z',
      pinned: false,
      excerpt: ''
    }
    bridge.notes.create.mockResolvedValue({ note: created, text: '' })
    bridge.notes.list
      .mockResolvedValueOnce({ notes: [NOTE_A, NOTE_B] })
      .mockResolvedValue({ notes: [created, NOTE_A, NOTE_B] })
    bridge.notes.get.mockResolvedValue({ text: '' })

    render(<NotesPage />)
    await screen.findByTestId(`note-row-${NOTE_A.id}`)
    fireEvent.click(screen.getByTestId('notes-new'))

    await waitFor(() => expect(bridge.notes.create).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByTestId(`note-row-${created.id}`)).toBeInTheDocument())
    expect(screen.getByTestId('note-title')).toHaveValue('未命名笔记')
  })
})

describe('自动保存 / Ctrl+S / 失败重试', () => {
  it('改正文后 600ms 自动保存（带标题与正文），保存态转「已保存」', async () => {
    vi.useFakeTimers()
    bridge.notes.save.mockResolvedValue({
      note: { ...NOTE_A, updatedAt: '2026-10-18T01:02:00.000Z' }
    })
    seedStore()
    render(<NotesPage />)

    fireEvent.change(screen.getByTestId('note-body'), { target: { value: '新的正文' } })
    expect(screen.getByTestId('notes-save-status')).toHaveTextContent('未保存')

    act(() => {
      vi.advanceTimersByTime(NOTE_AUTOSAVE_MS)
    })
    await flush()

    expect(bridge.notes.save).toHaveBeenCalledWith({
      id: NOTE_A.id,
      title: '周会纪要',
      text: '新的正文'
    })
    expect(screen.getByTestId('notes-save-status')).toHaveTextContent('已保存')
  })

  it('Ctrl+S 立即保存（不等 debounce）', async () => {
    bridge.notes.save.mockResolvedValue({ note: NOTE_A })
    seedStore()
    render(<NotesPage />)

    fireEvent.change(screen.getByTestId('note-title'), { target: { value: '新标题' } })
    fireEvent.keyDown(screen.getByTestId('note-body'), { key: 's', ctrlKey: true })
    await flush()

    expect(bridge.notes.save).toHaveBeenCalledWith({
      id: NOTE_A.id,
      title: '新标题',
      text: NOTE_A_BODY
    })
  })

  it('保存失败显示「保存失败 · 重试」；点它重试成功后回到已保存', async () => {
    vi.useFakeTimers()
    bridge.notes.save
      .mockRejectedValueOnce(
        new Error('Error invoking remote method "notes:save": Error: 磁盘满了')
      )
      .mockResolvedValue({ note: NOTE_A })
    seedStore()
    render(<NotesPage />)

    fireEvent.change(screen.getByTestId('note-body'), { target: { value: '改一下' } })
    act(() => {
      vi.advanceTimersByTime(NOTE_AUTOSAVE_MS)
    })
    await flush()

    const status = screen.getByTestId('notes-save-status')
    expect(status).toHaveTextContent('保存失败 · 重试')
    expect(screen.getByTestId('notes-save-error')).toHaveTextContent('磁盘满了')

    fireEvent.click(status)
    await flush()
    expect(bridge.notes.save).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('notes-save-status')).toHaveTextContent('已保存')
  })
})

describe('预览 / 删除 / 搜索 / 置顶 / 窄窗', () => {
  it('编辑⇄预览：预览复用 .markdown-body 渲染，不复造管线', async () => {
    seedStore()
    render(<NotesPage />)

    fireEvent.click(screen.getByTestId('notes-mode-preview'))
    const preview = await screen.findByTestId('note-preview')
    expect(preview.querySelector('.markdown-body')).not.toBeNull()
    expect(preview.querySelector('strong')).toHaveTextContent('下周上线')

    fireEvent.click(screen.getByTestId('notes-mode-edit'))
    expect(screen.getByTestId('note-body')).toBeInTheDocument()
  })

  it('删除：先弹确认，确认后调 remove 并刷新列表', async () => {
    seedStore()
    render(<NotesPage />)

    fireEvent.click(screen.getByTestId('notes-delete'))
    expect(await screen.findByText('删除这篇笔记？')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('notes-delete-confirm'))

    await waitFor(() => expect(bridge.notes.remove).toHaveBeenCalledWith(NOTE_A.id))
    await waitFor(() => expect(screen.getByTestId('notes-list')).toBeInTheDocument())
  })

  it('搜索走主进程并显示命中 snippet；清空恢复列表', async () => {
    vi.useFakeTimers()
    bridge.notes.search.mockResolvedValue({
      hits: [{ id: NOTE_A.id, title: '周会纪要', snippet: '…决定下周上线…' }]
    })
    seedStore()
    render(<NotesPage />)

    fireEvent.change(screen.getByTestId('notes-search'), { target: { value: '上线' } })
    act(() => {
      vi.advanceTimersByTime(NOTE_SEARCH_MS)
    })
    await flush()

    expect(bridge.notes.search).toHaveBeenCalledWith('上线')
    expect(screen.getByTestId(`note-row-${NOTE_A.id}`)).toHaveTextContent('决定下周上线…')

    fireEvent.click(screen.getByTestId('notes-search-clear'))
    expect(screen.getByTestId(`note-row-${NOTE_B.id}`)).toBeInTheDocument()
  })

  it('置顶：调 notes:pin，列表按置顶优先重排', async () => {
    seedStore({ notes: [NOTE_A, NOTE_B] })
    bridge.notes.pin.mockResolvedValue({ note: { ...NOTE_A, pinned: true } })
    render(<NotesPage />)

    fireEvent.click(screen.getByTestId(`note-pin-${NOTE_A.id}`))
    await act(async () => {
      await Promise.resolve()
    })

    expect(bridge.notes.pin).toHaveBeenCalledWith(NOTE_A.id, true)
    expect(screen.getByTestId(`note-pin-${NOTE_A.id}`)).toHaveAttribute('aria-pressed', 'true')
  })

  it('打开数据文件夹：调 openFolder 并在列表脚注显示路径', async () => {
    bridge.notes.openFolder.mockResolvedValue({ path: 'C:\\用户\\notes' })
    seedStore()
    render(<NotesPage />)

    fireEvent.click(screen.getByTestId('notes-open-folder'))
    await flush()

    expect(bridge.notes.openFolder).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('notes-notice')).toHaveTextContent('C:\\用户\\notes')
  })

  it('窄窗 <900：列表整屏；选中后进编辑器，可「返回列表」', async () => {
    mockMatchMedia(true)
    render(<NotesPage />)

    expect(await screen.findByTestId(`note-row-${NOTE_A.id}`)).toBeInTheDocument()
    expect(screen.queryByTestId('note-title')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId(`note-row-${NOTE_A.id}`))
    await waitFor(() => expect(screen.getByTestId('note-title')).toHaveValue('周会纪要'))
    expect(screen.queryByTestId('notes-list')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('notes-back'))
    expect(await screen.findByTestId(`note-row-${NOTE_A.id}`)).toBeInTheDocument()
    expect(screen.queryByTestId('note-title')).not.toBeInTheDocument()
  })
})
