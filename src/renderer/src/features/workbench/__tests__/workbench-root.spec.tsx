// @vitest-environment jsdom
/**
 * 换项目后工作台必须换根（回归）。
 *
 * 根因存档（round 42）：`useWorkbenchRoot` 曾只选 `state.projectOf`（函数引用恒定）——`mappings`
 * 变了（"移至项目" / 快照迟到）**不会触发重渲染** → 树还是旧项目的目录名与清单，而主进程已按
 * 新根解析 → 点文件夹报"这个文件夹不在磁盘上了"。修法 = 订阅 `mappings` 并现算 projectOf。
 *
 * 根因存档（round 49，用户第二次报"切换对话后文件区路径没刷新"）：渲染端的映射是**乐观**的
 * （本地先补、PUT 还在飞），主进程（会话根的唯一解析者）此刻还按兜底根解析 —— 按根开工的工具
 * 在那段窗口里列出来的目录 / 起来的 shell cwd 都是别的文件夹，而且**不会再重来一次**。
 * 修法 = `pending` 标记 + `settling`（工具据此推迟第一次请求）。
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultSettings } from '@shared/settings'
import { clearKyclawBridge, installKyclawBridge } from '@renderer/__tests__/kyclaw-bridge'
import { resetProjectsStore, useProjectsStore } from '@renderer/features/projects/projects-store'
import { useSessionsStore } from '@renderer/features/sessions/sessions-store'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { useWorkbenchRoot } from '../use-workbench-root'

const PROJECT = {
  id: 'p1',
  name: '项目一',
  path: 'D:\\乙区',
  createdAt: '2026-10-11T00:00:00.000Z'
}

beforeEach(() => {
  resetProjectsStore()
  const settings = {
    ...defaultSettings(),
    workspaces: [
      { path: 'D:\\甲区', mode: 'ask' as const },
      { path: 'D:\\乙区', mode: 'ask' as const }
    ],
    projects: [PROJECT]
  }
  installKyclawBridge(settings)
  useSettingsStore.setState({ settings, loaded: true })
  useSessionsStore.setState({ activeId: 'thread-1', loaded: true })
  useProjectsStore.setState({ mappings: {}, loaded: true, error: null })
})

afterEach(() => {
  clearKyclawBridge()
  resetProjectsStore()
})

describe('useWorkbenchRoot：换项目换根（响应式）', () => {
  it('判不出根（两个工作区、无映射、无默认）→ 映射一到，根立刻换成项目目录', () => {
    const { result } = renderHook(() => useWorkbenchRoot())
    expect(result.current.rootPath).toBeNull()

    act(() => useProjectsStore.setState({ mappings: { 'thread-1': 'p1' } }))

    expect(result.current.rootPath).toBe('D:\\乙区')
    expect(result.current.rootName).toBe('乙区')
  })

  it('移至项目：映射改写 → 根跟着改写（旧根不留）', () => {
    useProjectsStore.setState({ mappings: { 'thread-1': 'p1' } })
    const { result } = renderHook(() => useWorkbenchRoot())
    expect(result.current.rootPath).toBe('D:\\乙区')

    act(() => useProjectsStore.setState({ mappings: {} }))

    expect(result.current.rootPath).toBeNull()
    expect(result.current.rootName).toBeNull()
  })
})

/**
 * round 55：无项目会话的根不再等于默认工作区本身 —— 每个会话在它下面占一个子目录
 * （`shared/session-dir.ts`）。rootPath 给真根（复制路径 / 附件相对路径按它算），
 * rootName 仍显示默认工作区的目录名（短 id 那串不适合当标题）。
 */
describe('useWorkbenchRoot：无项目会话落在默认工作区下的会话子目录（round 55）', () => {
  beforeEach(() => {
    const settings = {
      ...defaultSettings(),
      workspaces: [
        { path: 'D:\\甲区', mode: 'ask' as const },
        { path: 'D:\\乙区', mode: 'ask' as const }
      ],
      defaultWorkspace: 'D:\\甲区',
      projects: [PROJECT]
    }
    installKyclawBridge(settings)
    useSettingsStore.setState({ settings, loaded: true })
  })

  it('无项目：rootPath = 默认工作区下的会话子目录，rootName 是默认工作区的目录名', () => {
    const { result } = renderHook(() => useWorkbenchRoot())

    expect(result.current.rootPath).toBe('D:\\甲区\\tasks\\thread-1')
    expect(result.current.rootName).toBe('甲区')
    expect(result.current.ready).toBe(true)
    expect(result.current.notice).toBeNull()
  })

  it('有项目的会话不受影响：rootPath 还是项目目录、标题是项目目录名', () => {
    useProjectsStore.setState({ mappings: { 'thread-1': 'p1' } })
    const { result } = renderHook(() => useWorkbenchRoot())

    expect(result.current.rootPath).toBe('D:\\乙区')
    expect(result.current.rootName).toBe('乙区')
  })
})

describe('useWorkbenchRoot：归属还在写（settling，round 49）', () => {
  it('本会话的映射还没回执 → settling 为真；回执落地翻假（根路径不动）', () => {
    useProjectsStore.setState({ mappings: { 'thread-1': 'p1' }, pending: { 'thread-1': true } })
    const { result } = renderHook(() => useWorkbenchRoot())

    // 渲染端已经把根画成项目目录了（乐观），但主进程此刻还会给出兜底根 → 工具先别开工
    expect(result.current.rootPath).toBe('D:\\乙区')
    expect(result.current.settling).toBe(true)

    act(() => useProjectsStore.setState({ pending: {} }))

    expect(result.current.settling).toBe(false)
    expect(result.current.rootPath).toBe('D:\\乙区')
  })

  it('在写的是别的会话：本会话不算 settling（只挡自己那条）', () => {
    useProjectsStore.setState({ mappings: { 'thread-1': 'p1' }, pending: { 'thread-9': true } })
    const { result } = renderHook(() => useWorkbenchRoot())

    expect(result.current.settling).toBe(false)
  })
})
