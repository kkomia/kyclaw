// @vitest-environment jsdom
/**
 * 换项目后工作台必须换根（回归）。
 *
 * 根因存档：`useWorkbenchRoot` 曾只选 `state.projectOf`（函数引用恒定）——`mappings` 变了
 * （"移至项目" / 快照迟到）**不会触发重渲染** → 树还是旧项目的目录名与清单，而主进程已按
 * 新根解析 → 点文件夹报"这个文件夹不在磁盘上了"。修法 = 订阅 `mappings` 并现算 projectOf。
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
