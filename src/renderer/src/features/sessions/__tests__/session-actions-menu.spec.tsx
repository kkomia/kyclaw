import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router'
import {
  clearKyclawBridge,
  installKyclawBridge,
  type KyclawBridgeStubs
} from '@renderer/__tests__/kyclaw-bridge'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { useProjectsStore, resetProjectsStore } from '@renderer/features/projects/projects-store'
import { resetSessionsStore, useSessionsStore } from '../sessions-store'
import { SessionActionsMenu } from '../SessionActionsMenu'
import { defaultSettings } from '@shared/settings'

/**
 * 会话动作菜单（round 24 抽取；侧栏行 ⋯ 与对话页顶部栏共用）：
 * 条目照图3（置顶 / 移至项目 ▸ / 从「<项目>」中移除 / 在文件资源管理器中打开 / 重命名 / 归档 /
 * 删除；「反馈」没有渠道不做）、动作全走 store（置顶/归档走 settings、移项目走映射通道、
 * 资源管理器走 bridge、重命名/删除走 sessions-store）、失败露给 onError。
 */
vi.mock('@renderer/lib/threads-api', () => ({
  fetchThreads: vi.fn(async () => []),
  fetchThreadMessages: vi.fn(async () => []),
  createThread: vi.fn(async (id: string, title?: string) => ({
    id,
    title: title ?? null,
    updatedAt: new Date().toISOString()
  })),
  renameThread: vi.fn(async (id: string, title: string) => ({
    id,
    title,
    updatedAt: new Date().toISOString()
  })),
  deleteThread: vi.fn(async () => undefined),
  truncateThread: vi.fn(async () => 0),
  generateThreadTitle: vi.fn(async () => ({ title: '', generated: false })),
  fetchThreadCompaction: vi.fn(async () => null),
  compactThread: vi.fn(async () => ({ compacted: false, compaction: null }))
}))

vi.mock('@renderer/lib/projects-api', () => ({
  fetchSessionProjects: vi.fn(async () => []),
  putSessionProject: vi.fn(async () => undefined)
}))

import { renameThread, deleteThread, createThread } from '@renderer/lib/threads-api'
import { putSessionProject } from '@renderer/lib/projects-api'

const THREAD_ID = 't1'

const PROJECT = {
  id: 'p1',
  name: '项目一',
  path: 'D:\\p1',
  createdAt: '2026-10-11T00:00:00.000Z'
}

interface Harness {
  bridge: KyclawBridgeStubs
  onError: ReturnType<typeof vi.fn>
}

function mount(
  options: {
    projectId?: string | null
    pinned?: string[]
    workspaces?: Array<{ path: string; mode: 'ask' | 'full' }>
    /** round 26：把这轮渲染的会话做成"草稿"（镜像里没有它，还没物化） */
    draft?: boolean
    /** 0.2.1（PB-053）：映射通道本版下架（501）→ 项目归属相关入口整体不出现 */
    projectsUnavailable?: boolean
  } = {}
): Harness {
  const initial = {
    ...defaultSettings(),
    projects: [PROJECT],
    pinnedThreads: options.pinned ?? [],
    workspaces: options.workspaces ?? []
  }
  const bridge = installKyclawBridge(initial)
  useSettingsStore.setState({ settings: initial, loaded: true })
  useProjectsStore.setState({
    mappings:
      options.projectId === undefined || options.projectId === null
        ? {}
        : { [THREAD_ID]: options.projectId },
    loaded: true,
    unavailable: options.projectsUnavailable === true,
    error: null
  })
  useSessionsStore.setState({
    threads:
      options.draft === true
        ? []
        : [{ id: THREAD_ID, title: '会话甲', updatedAt: '2026-10-11T00:00:00.000Z' }],
    activeId: THREAD_ID,
    loaded: true,
    error: null,
    notices: {}
  })
  const onError = vi.fn()
  render(
    <MemoryRouter>
      <SessionActionsMenu
        threadId={THREAD_ID}
        title="会话甲"
        onError={onError}
        trigger={
          <button type="button" data-testid="actions-trigger">
            会话甲
          </button>
        }
      />
    </MemoryRouter>
  )
  return { bridge, onError }
}

function openMenu(): void {
  fireEvent.keyDown(screen.getByTestId('actions-trigger'), { key: 'ArrowDown' })
}

/** Radix：子菜单要 ArrowRight 展开 */
async function openSubmenu(testId: string): Promise<void> {
  const trigger = screen.getByTestId(testId)
  trigger.focus()
  fireEvent.keyDown(trigger, { key: 'ArrowRight' })
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  resetSessionsStore()
  resetProjectsStore()
  vi.mocked(renameThread).mockClear()
  vi.mocked(deleteThread).mockClear()
  vi.mocked(createThread).mockClear()
  vi.mocked(putSessionProject).mockClear()
})

afterEach(() => {
  clearKyclawBridge()
  useSettingsStore.setState({ settings: defaultSettings(), loaded: false })
})

describe('SessionActionsMenu · 结构与顺序（图3）', () => {
  it('无项目：置顶 / 移至项目 ▸ / 在文件资源管理器中打开 / 重命名 / 归档 / 删除（danger 最后）；没有「反馈」', () => {
    mount()
    openMenu()

    for (const id of [
      'session-pin-t1',
      'session-move-t1',
      'session-open-t1',
      'session-rename-t1',
      'session-archive-t1',
      'session-delete-t1'
    ]) {
      expect(screen.getByTestId(id)).toBeInTheDocument()
    }
    expect(screen.queryByTestId('session-leave-project-t1')).not.toBeInTheDocument()
    const texts = screen
      .getAllByRole('menuitem')
      .map((item) => item.textContent?.replace('▸', '').trim() ?? '')
    // task-61：行多了描述（第二行），按每个条目的可见文本前缀判顺序
    const lastThree = texts
      .slice(-3)
      .map((text) => text.split(/只改|从当前列表|连同/)[0]?.trim() ?? text)
    expect(lastThree).toEqual(['重命名', '归档', '删除'])
    expect(screen.queryByText('反馈')).not.toBeInTheDocument()
  })

  it('归属项目时多出「从「项目一」中移除」（在移至项目之后）', () => {
    mount({ projectId: 'p1' })
    openMenu()

    const leave = screen.getByTestId('session-leave-project-t1')
    expect(leave).toHaveTextContent('从「项目一」中移除')
  })

  /**
   * 0.2.1（PB-053）：会话↔项目映射的宿主路由本版下架（501）→ 旧项目数据不兼容，
   * 「移至项目 / 从项目中移除」整体不出现（不给点了也不生效的入口）。
   */
  it('映射通道不可用：没有「移至项目」也没有「从项目中移除」', () => {
    mount({ projectsUnavailable: true, projectId: 'p1' })
    openMenu()

    expect(screen.queryByTestId('session-move-t1')).not.toBeInTheDocument()
    expect(screen.queryByTestId('session-leave-project-t1')).not.toBeInTheDocument()
  })
})

describe('SessionActionsMenu · 动作', () => {
  it('置顶 / 取消置顶：整表替换 pinnedThreads；已置顶时标签变「取消置顶」', async () => {
    const { bridge } = mount()
    openMenu()
    fireEvent.keyDown(screen.getByTestId('session-pin-t1'), { key: 'Enter' })

    await waitFor(() => expect(bridge.update).toHaveBeenCalledWith({ pinnedThreads: [THREAD_ID] }))

    // 已置顶：标签与动作反向
    useSettingsStore.setState((state) => ({
      settings: { ...state.settings, pinnedThreads: [THREAD_ID] }
    }))
    openMenu()
    expect(screen.getByTestId('session-pin-t1')).toHaveTextContent('取消置顶')
    fireEvent.keyDown(screen.getByTestId('session-pin-t1'), { key: 'Enter' })
    await waitFor(() => expect(bridge.update).toHaveBeenLastCalledWith({ pinnedThreads: [] }))
  })

  it('移至项目 ▸：子菜单列出项目与「无项目」，选中项目走 T18 映射通道（PUT）', async () => {
    mount()
    openMenu()
    await openSubmenu('session-move-t1')
    expect(screen.getByTestId('session-move-t1-p1')).toHaveTextContent('项目一')
    expect(screen.getByTestId('session-move-none-t1')).toHaveTextContent('无项目')
    fireEvent.click(screen.getByTestId('session-move-t1-p1'))
    await waitFor(() => expect(putSessionProject).toHaveBeenCalledWith(THREAD_ID, 'p1'))
  })

  it('从「项目一」中移除：归属置空（同一条映射通道，projectId = null）', async () => {
    mount({ projectId: 'p1' })
    openMenu()
    fireEvent.keyDown(screen.getByTestId('session-leave-project-t1'), { key: 'Enter' })
    await waitFor(() => expect(putSessionProject).toHaveBeenCalledWith(THREAD_ID, null))
  })

  it('在文件资源管理器中打开：判得出工作区才可点（bridge）', async () => {
    const { bridge } = mount({ workspaces: [{ path: 'D:\\ws', mode: 'ask' }] })
    openMenu()
    expect(screen.getByTestId('session-open-t1')).not.toHaveAttribute('data-disabled')
    fireEvent.keyDown(screen.getByTestId('session-open-t1'), { key: 'Enter' })
    await waitFor(() => expect(bridge.workspace.openInExplorer).toHaveBeenCalledWith(THREAD_ID))
  })

  it('在文件资源管理器中打开：判不出唯一工作区 → 禁用（点了没反应的事不给做）', () => {
    mount()
    openMenu()
    expect(screen.getByTestId('session-open-t1')).toHaveAttribute('data-disabled')
  })

  it('归档：写快照（标题/项目/时间）进 settings.archivedThreads', async () => {
    const { bridge } = mount({ projectId: 'p1' })
    openMenu()
    fireEvent.keyDown(screen.getByTestId('session-archive-t1'), { key: 'Enter' })

    await waitFor(() => {
      const patch = bridge.update.mock.calls.at(-1)?.[0] as {
        archivedThreads?: Array<Record<string, unknown>>
      }
      expect(patch.archivedThreads?.[0]).toMatchObject({
        threadId: THREAD_ID,
        title: '会话甲',
        projectId: 'p1'
      })
      expect(typeof patch.archivedThreads?.[0]?.archivedAt).toBe('string')
    })
  })

  it('重命名：受控 Dialog → sessions-store.rename（PATCH）→ store 里标题跟着变', async () => {
    mount()
    openMenu()
    fireEvent.keyDown(screen.getByTestId('session-rename-t1'), { key: 'Enter' })

    const input = await screen.findByTestId('session-rename-input')
    expect(input).toHaveValue('会话甲')
    fireEvent.change(input, { target: { value: '改过的名字' } })
    fireEvent.click(screen.getByTestId('session-rename-save'))

    await waitFor(() =>
      expect(vi.mocked(renameThread)).toHaveBeenCalledWith(THREAD_ID, '改过的名字')
    )
    await waitFor(() =>
      expect(
        useSessionsStore.getState().threads.find((thread) => thread.id === THREAD_ID)?.title
      ).toBe('改过的名字')
    )
  })

  it('删除：二次确认后才真删（DELETE）；取消不删', async () => {
    mount()
    openMenu()
    fireEvent.keyDown(screen.getByTestId('session-delete-t1'), { key: 'Enter' })
    fireEvent.click(await screen.findByTestId('session-delete-cancel'))
    expect(vi.mocked(deleteThread)).not.toHaveBeenCalled()

    openMenu()
    fireEvent.keyDown(screen.getByTestId('session-delete-t1'), { key: 'Enter' })
    fireEvent.click(await screen.findByTestId('session-delete-confirm'))
    await waitFor(() => expect(vi.mocked(deleteThread)).toHaveBeenCalledWith(THREAD_ID))
  })

  it('失败露给 onError（置顶写盘失败）：调用方决定露在哪（侧栏行 / 顶栏一行）', async () => {
    const { bridge, onError } = mount()
    bridge.update.mockRejectedValueOnce(new Error('设置落盘失败'))
    openMenu()
    fireEvent.keyDown(screen.getByTestId('session-pin-t1'), { key: 'Enter' })

    await waitFor(() => expect(onError).toHaveBeenCalledWith('设置落盘失败'))
  })
})

describe('SessionActionsMenu · round 26 可用性收口（不许"灰着不让用"）', () => {
  it('无项目 + 无工作区：只有「在文件资源管理器中打开」禁用（确实判不出工作区），其余都可点', () => {
    mount()
    openMenu()

    for (const id of [
      'session-pin-t1',
      'session-move-t1',
      'session-rename-t1',
      'session-archive-t1',
      'session-delete-t1'
    ]) {
      expect(screen.getByTestId(id), id).not.toHaveAttribute('data-disabled')
    }
    expect(screen.getByTestId('session-open-t1')).toHaveAttribute('data-disabled')
  })

  it('无项目 + 有工作区：连「打开」也可点（全菜单零禁用）', () => {
    mount({ workspaces: [{ path: 'D:\\ws', mode: 'ask' }] })
    openMenu()

    for (const id of [
      'session-pin-t1',
      'session-move-t1',
      'session-open-t1',
      'session-rename-t1',
      'session-archive-t1',
      'session-delete-t1'
    ]) {
      expect(screen.getByTestId(id), id).not.toHaveAttribute('data-disabled')
    }
  })

  it('已置顶：置顶项变「取消置顶」且可点', () => {
    mount({ pinned: [THREAD_ID] })
    openMenu()

    const pin = screen.getByTestId('session-pin-t1')
    expect(pin).toHaveTextContent('取消置顶')
    expect(pin).not.toHaveAttribute('data-disabled')
  })

  it('已在项目：多出的「从「项目一」中移除」可点', () => {
    mount({ projectId: 'p1' })
    openMenu()

    expect(screen.getByTestId('session-leave-project-t1')).not.toHaveAttribute('data-disabled')
  })
})

describe('SessionActionsMenu · 草稿会话（round 26：同一份可用性）', () => {
  it('草稿的菜单条目齐全（置顶/移至项目/打开/重命名/归档/删除都在）', () => {
    mount({ draft: true })
    openMenu()

    for (const id of [
      'session-pin-t1',
      'session-move-t1',
      'session-open-t1',
      'session-rename-t1',
      'session-archive-t1',
      'session-delete-t1'
    ]) {
      expect(screen.getByTestId(id), id).toBeInTheDocument()
    }
  })

  it('草稿置顶：先物化（POST /api/threads）成功后才写 pinnedThreads', async () => {
    const { bridge } = mount({ draft: true })
    openMenu()
    fireEvent.keyDown(screen.getByTestId('session-pin-t1'), { key: 'Enter' })

    await waitFor(() => expect(vi.mocked(createThread)).toHaveBeenCalledWith(THREAD_ID, undefined))
    await waitFor(() => expect(bridge.update).toHaveBeenCalledWith({ pinnedThreads: [THREAD_ID] }))
    // 物化后进了镜像：这条不再是草稿
    expect(useSessionsStore.getState().threads.some((thread) => thread.id === THREAD_ID)).toBe(true)
  })

  it('草稿移至项目：先物化，再走 T18 映射通道（PUT）', async () => {
    mount({ draft: true })
    openMenu()
    await openSubmenu('session-move-t1')
    fireEvent.click(screen.getByTestId('session-move-t1-p1'))

    await waitFor(() => expect(vi.mocked(createThread)).toHaveBeenCalledWith(THREAD_ID, undefined))
    await waitFor(() => expect(putSessionProject).toHaveBeenCalledWith(THREAD_ID, 'p1'))
  })

  it('草稿归档：先物化，再写快照（标题/时间进 settings.archivedThreads）', async () => {
    const { bridge } = mount({ draft: true })
    openMenu()
    fireEvent.keyDown(screen.getByTestId('session-archive-t1'), { key: 'Enter' })

    await waitFor(() => {
      const patch = bridge.update.mock.calls.at(-1)?.[0] as {
        archivedThreads?: Array<Record<string, unknown>>
      }
      expect(patch.archivedThreads?.[0]).toMatchObject({ threadId: THREAD_ID, title: '会话甲' })
    })
    expect(vi.mocked(createThread)).toHaveBeenCalledTimes(1)
  })

  it('草稿重命名：就地改本地标题（draftTitles），不发 PATCH', async () => {
    mount({ draft: true })
    openMenu()
    fireEvent.keyDown(screen.getByTestId('session-rename-t1'), { key: 'Enter' })

    const input = await screen.findByTestId('session-rename-input')
    fireEvent.change(input, { target: { value: '草稿名' } })
    fireEvent.click(screen.getByTestId('session-rename-save'))

    await waitFor(() => expect(useSessionsStore.getState().draftTitles[THREAD_ID]).toBe('草稿名'))
    expect(vi.mocked(renameThread)).not.toHaveBeenCalled()
  })

  it('草稿删除：就地丢弃（不发 DELETE），选中接力到新的草稿', async () => {
    mount({ draft: true })
    openMenu()
    fireEvent.keyDown(screen.getByTestId('session-delete-t1'), { key: 'Enter' })
    fireEvent.click(await screen.findByTestId('session-delete-confirm'))

    await waitFor(() => expect(useSessionsStore.getState().activeId).not.toBe(THREAD_ID))
    expect(vi.mocked(deleteThread)).not.toHaveBeenCalled()
  })

  it('草稿物化失败：动作不做（没写置顶）、原因露给 onError', async () => {
    const { bridge, onError } = mount({ draft: true })
    vi.mocked(createThread).mockRejectedValueOnce(new Error('线程服务返回 500'))
    openMenu()
    fireEvent.keyDown(screen.getByTestId('session-pin-t1'), { key: 'Enter' })

    await waitFor(() => expect(onError).toHaveBeenCalledWith('线程服务返回 500'))
    expect(bridge.update).not.toHaveBeenCalled()
  })
})
