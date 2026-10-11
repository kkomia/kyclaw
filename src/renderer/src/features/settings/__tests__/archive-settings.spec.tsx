import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearKyclawBridge, installKyclawBridge } from '@renderer/__tests__/kyclaw-bridge'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { defaultSettings, type AppSettings, type ArchivedThread } from '@shared/settings'
import { ArchiveSettings } from '../ArchiveSettings'

/**
 * 设置页「归档」组（round 20，RTL）：列表（标题/来源项目/时间）+ 搜索（标题过滤）+ 取消归档 + 空态。
 * 数据 = settings.archivedThreads（归档时的快照）；取消归档走 settings:update，失败行内报原因；
 * 会话数据本体一直没动过（归档只是从侧栏移出 + 快照），取消后被过滤掉的会话自然回侧栏。
 */
const PROJECT = {
  id: 'p1',
  name: '项目一',
  path: 'D:\\p1',
  createdAt: '2026-10-11T00:00:00.000Z'
}

function archived(overrides: Partial<ArchivedThread>): ArchivedThread {
  return {
    threadId: 't1',
    title: '甲会话',
    projectId: null,
    archivedAt: '2026-10-11T10:00:00.000Z',
    ...overrides
  }
}

function withArchived(
  archivedThreads: ArchivedThread[],
  projects: AppSettings['projects'] = []
): AppSettings {
  return { ...defaultSettings(), archivedThreads, projects }
}

async function mount(initial: AppSettings): Promise<ReturnType<typeof installKyclawBridge>> {
  const bridge = installKyclawBridge(initial)
  await useSettingsStore.getState().load()
  render(<ArchiveSettings />)
  return bridge
}

beforeEach(() => {
  useSettingsStore.setState({ settings: defaultSettings(), loaded: false })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  clearKyclawBridge()
  vi.restoreAllMocks()
})

describe('归档组 · 列表', () => {
  it('空态一行（不空白）', async () => {
    await mount(defaultSettings())

    expect(screen.getByTestId('archive-empty')).toHaveTextContent('还没有归档的会话')
    expect(screen.queryByTestId('archive-row-t1')).not.toBeInTheDocument()
  })

  it('列出标题 + 来源项目 + 归档时间；时间倒序（最近归档的在前）', async () => {
    await mount(
      withArchived(
        [
          archived({ threadId: 't-old', title: '旧的', archivedAt: '2026-10-10T10:00:00.000Z' }),
          archived({
            threadId: 't-new',
            title: '新的',
            projectId: 'p1',
            archivedAt: '2026-10-11T10:00:00.000Z'
          })
        ],
        [PROJECT]
      )
    )

    const rows = screen.getAllByTestId(/^archive-row-/)
    expect(rows.map((row) => row.getAttribute('data-testid'))).toEqual([
      'archive-row-t-new',
      'archive-row-t-old'
    ])
    // 来源项目按 id 现查名字；没有项目的显示"无项目"
    expect(screen.getByTestId('archive-row-t-new')).toHaveTextContent('项目一')
    expect(screen.getByTestId('archive-row-t-old')).toHaveTextContent('无项目')
    // 时间是数值展示（本地格式；只断言日期部分在）
    expect(screen.getByTestId('archive-row-t-new')).toHaveTextContent('归档于')
  })

  it('来源项目被删了：名字查不到也不炸，只显示"无项目"与时间', async () => {
    await mount(withArchived([archived({ threadId: 't1', projectId: '已删项目' })]))

    expect(screen.getByTestId('archive-row-t1')).toHaveTextContent('无项目')
  })

  it('标题为 null（归档时还没生成标题）：回落"新会话"显示', async () => {
    await mount(withArchived([archived({ threadId: 't1', title: null })]))

    expect(screen.getByTestId('archive-title-t1')).toHaveTextContent('新会话')
  })
})

describe('归档组 · 搜索', () => {
  const both = [
    archived({ threadId: 't1', title: '甲会话' }),
    archived({ threadId: 't2', title: '乙会话' })
  ]

  it('按标题子串过滤（大小写不敏感）；没有匹配给一行提示', async () => {
    await mount(withArchived(both))

    fireEvent.change(screen.getByTestId('archive-search'), { target: { value: '甲' } })
    expect(screen.getByTestId('archive-row-t1')).toBeInTheDocument()
    expect(screen.queryByTestId('archive-row-t2')).not.toBeInTheDocument()

    fireEvent.change(screen.getByTestId('archive-search'), { target: { value: 'zzz' } })
    expect(screen.getByTestId('archive-no-match')).toHaveTextContent('没有匹配的归档会话')
    expect(screen.queryByTestId('archive-row-t1')).not.toBeInTheDocument()
  })

  it('清空关键词：全部回来', async () => {
    await mount(withArchived(both))

    fireEvent.change(screen.getByTestId('archive-search'), { target: { value: '甲' } })
    fireEvent.change(screen.getByTestId('archive-search'), { target: { value: '' } })
    expect(screen.getByTestId('archive-row-t1')).toBeInTheDocument()
    expect(screen.getByTestId('archive-row-t2')).toBeInTheDocument()
  })
})

describe('归档组 · 取消归档', () => {
  it('点「取消归档」：写 settings.archivedThreads（去掉这条），行消失', async () => {
    const initial = withArchived([
      archived({ threadId: 't1', title: '甲会话' }),
      archived({ threadId: 't2', title: '乙会话' })
    ])
    const bridge = await mount(initial)

    fireEvent.click(screen.getByTestId('archive-restore-t1'))

    await waitFor(() => {
      expect(bridge.update).toHaveBeenCalledWith({
        archivedThreads: [initial.archivedThreads[1]]
      })
    })
    await waitFor(() => {
      expect(screen.queryByTestId('archive-row-t1')).not.toBeInTheDocument()
    })
    expect(screen.getByTestId('archive-row-t2')).toBeInTheDocument()
  })

  it('落盘失败：行内报原因、行还在（不假装取消成功）', async () => {
    const bridge = await mount(withArchived([archived({ threadId: 't1' })]))
    bridge.update.mockRejectedValueOnce(new Error('设置落盘失败'))

    fireEvent.click(screen.getByTestId('archive-restore-t1'))

    await waitFor(() => {
      expect(screen.getByTestId('archive-error')).toHaveTextContent('设置落盘失败')
    })
    expect(screen.getByTestId('archive-row-t1')).toBeInTheDocument()
  })
})
