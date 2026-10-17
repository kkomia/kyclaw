import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearKyclawBridge, installKyclawBridge } from '@renderer/__tests__/kyclaw-bridge'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { DEFAULT_SETTINGS, defaultSettings } from '@shared/settings'
import type { ProviderConfig } from '@shared/providers'

/**
 * 渲染端设置副本：读落盘（settings:get）→ 应用外观（html 属性）；
 * 用户改动 → 先应用再落盘（settings:update），落盘失败不回滚（本次会话仍生效，只记日志）。
 */
const html = (): HTMLElement => document.documentElement

function store(): ReturnType<typeof useSettingsStore.getState> {
  return useSettingsStore.getState()
}

beforeEach(() => {
  html().removeAttribute('data-theme')
  html().style.removeProperty('--ui-scale')
  useSettingsStore.setState({ settings: defaultSettings(), loaded: false })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  clearKyclawBridge()
  vi.restoreAllMocks()
})

describe('settings store · load（启动时读落盘）', () => {
  it('把落盘的主题与字号应用到 html，并标 loaded', async () => {
    installKyclawBridge({ ...DEFAULT_SETTINGS, theme: 'dark', uiFontSize: 16 })

    await store().load()

    expect(html().getAttribute('data-theme')).toBe('dark')
    expect(html().style.getPropertyValue('--ui-scale')).toBe('1.143')
    expect(store().settings).toEqual({ ...DEFAULT_SETTINGS, theme: 'dark', uiFontSize: 16 })
    expect(store().loaded).toBe(true)
  })

  it('没有 preload 桥（浏览器 / 单测环境）时用默认值，不抛', async () => {
    clearKyclawBridge()

    await expect(store().load()).resolves.toBeUndefined()
    expect(store().settings).toEqual(DEFAULT_SETTINGS)
    expect(html().style.getPropertyValue('--ui-scale')).toBe('1.000')
    expect(store().loaded).toBe(true)
  })

  it('主进程读失败时不炸启动：用默认值，且留下日志', async () => {
    const bridge = installKyclawBridge()
    bridge.get.mockRejectedValueOnce(new Error('ipc 断了'))

    await expect(store().load()).resolves.toBeUndefined()

    expect(store().settings).toEqual(DEFAULT_SETTINGS)
    expect(store().loaded).toBe(true)
    expect(console.error).toHaveBeenCalled()
  })
})

describe('settings store · update（用户改动）', () => {
  it('立刻应用（不等落盘），补丁按原样发给主进程', async () => {
    const bridge = installKyclawBridge()

    await store().update({ theme: 'dark' })

    expect(html().getAttribute('data-theme')).toBe('dark')
    expect(bridge.update).toHaveBeenCalledWith({ theme: 'dark' })
    expect(store().settings).toEqual({ ...DEFAULT_SETTINGS, theme: 'dark' })
  })

  it('以主进程回吐的合并结果为准（落盘后的那份才是真相）', async () => {
    const bridge = installKyclawBridge()
    bridge.update.mockResolvedValueOnce({ ...DEFAULT_SETTINGS, theme: 'dark', uiFontSize: 13 })

    await store().update({ theme: 'dark' })

    expect(store().settings).toEqual({ ...DEFAULT_SETTINGS, theme: 'dark', uiFontSize: 13 })
    expect(html().style.getPropertyValue('--ui-scale')).toBe('0.929')
  })

  it('落盘失败：本次改动仍生效，不抛，留日志（写失败不该让 UI 跳回去）', async () => {
    const bridge = installKyclawBridge()
    bridge.update.mockRejectedValueOnce(new Error('磁盘满了'))

    await expect(store().update({ theme: 'light' })).resolves.toBeUndefined()

    expect(html().getAttribute('data-theme')).toBe('light')
    expect(store().settings).toEqual({ ...DEFAULT_SETTINGS, theme: 'light' })
    expect(console.error).toHaveBeenCalled()
  })

  it('没有 preload 桥时只在本地生效，不抛', async () => {
    clearKyclawBridge()

    await expect(store().update({ uiFontSize: 16 })).resolves.toBeUndefined()

    expect(html().style.getPropertyValue('--ui-scale')).toBe('1.143')
    expect(store().settings).toEqual({ ...DEFAULT_SETTINGS, uiFontSize: 16 })
  })
})

describe('settings store · provider（模型设置页用）', () => {
  const DEEPSEEK: ProviderConfig = {
    id: 'deepseek',
    type: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    isDefault: true
  }

  it('saveProviders：补丁原样发出去，以落盘回吐为准（不做乐观应用）', async () => {
    const bridge = installKyclawBridge()

    await store().saveProviders([DEEPSEEK])

    expect(bridge.update).toHaveBeenCalledWith({ providers: [DEEPSEEK] })
    expect(store().settings.providers).toEqual([DEEPSEEK])
  })

  it('saveProviders 落盘失败 → 抛给调用方，store 保持原样（UI 才能报错）', async () => {
    const bridge = installKyclawBridge()
    bridge.update.mockRejectedValueOnce(new Error('磁盘满了'))

    await expect(store().saveProviders([DEEPSEEK])).rejects.toThrow('磁盘满了')

    expect(store().settings.providers).toEqual([])
  })

  it('没有 preload 桥时保存会抛（不假装成功）', async () => {
    clearKyclawBridge()

    await expect(store().saveProviders([DEEPSEEK])).rejects.toThrow(/设置通道不可用/)
    await expect(store().removeProvider('deepseek')).rejects.toThrow(/设置通道不可用/)
  })

  it('removeProvider：走 settings:remove-provider，并以回吐设置为准', async () => {
    const bridge = installKyclawBridge({ ...DEFAULT_SETTINGS, providers: [DEEPSEEK] })

    await store().removeProvider('deepseek')

    expect(bridge.removeProvider).toHaveBeenCalledWith('deepseek')
    expect(store().settings.providers).toEqual([])
  })
})

describe('settings store · workspace（设置页工作区组用）', () => {
  const PROJECT = 'D:\\项目\\demo'

  it('pickWorkspace：走 workspace:pick，以主进程回吐的设置为准', async () => {
    const bridge = installKyclawBridge()

    await store().pickWorkspace()

    expect(bridge.workspace.pick).toHaveBeenCalledTimes(1)
    expect(store().settings.workspaces.length).toBeGreaterThan(0)
  })

  it('addWorkspace（一律 ask）/ setWorkspaceMode / removeWorkspace：原样带参，回吐后 store 跟着走', async () => {
    const bridge = installKyclawBridge({
      ...DEFAULT_SETTINGS,
      workspaces: [{ path: PROJECT, mode: 'ask' }]
    })

    await store().addWorkspace(PROJECT)
    expect(bridge.workspace.add).toHaveBeenCalledWith(PROJECT)
    expect(store().settings.workspaces).toEqual([{ path: PROJECT, mode: 'ask' }])

    await store().setWorkspaceMode(PROJECT, 'full')
    expect(bridge.workspace.setMode).toHaveBeenCalledWith(PROJECT, 'full')
    expect(store().settings.workspaces).toEqual([{ path: PROJECT, mode: 'full' }])

    await store().removeWorkspace(PROJECT)
    expect(bridge.workspace.remove).toHaveBeenCalledWith(PROJECT)
    expect(store().settings.workspaces).toEqual([])
  })

  it('失败抛给调用方（不乐观改 UI）：store 里那份保持原样', async () => {
    const bridge = installKyclawBridge({
      ...DEFAULT_SETTINGS,
      workspaces: [{ path: PROJECT, mode: 'ask' }]
    })
    await store().load()
    bridge.workspace.add.mockRejectedValueOnce(new Error('不是文件夹'))

    await expect(store().addWorkspace('D:\\没有')).rejects.toThrow('不是文件夹')

    expect(store().settings.workspaces).toEqual([{ path: PROJECT, mode: 'ask' }])
  })

  it('没有 preload 桥（浏览器 / 单测环境）：四个动作都抛"工作区通道不可用"', async () => {
    clearKyclawBridge()

    await expect(store().pickWorkspace()).rejects.toThrow(/工作区通道不可用/)
    await expect(store().addWorkspace(PROJECT)).rejects.toThrow(/工作区通道不可用/)
    await expect(store().setWorkspaceMode(PROJECT, 'full')).rejects.toThrow(/工作区通道不可用/)
    await expect(store().removeWorkspace(PROJECT)).rejects.toThrow(/工作区通道不可用/)
  })
})

describe('settings store · allowToolForever（审批卡"永久允许"）', () => {
  const PROJECT = 'D:\\项目\\demo'

  it('追加一条规则并落盘（工具 + 工作区），store 跟着落盘结果走', async () => {
    const bridge = installKyclawBridge(defaultSettings())

    await store().allowToolForever('write', PROJECT)

    expect(bridge.update).toHaveBeenCalledWith({
      permissions: { rules: [{ tool: 'write', workspace: PROJECT, mode: 'allow' }] }
    })
    expect(store().settings.permissions.rules).toEqual([
      { tool: 'write', workspace: PROJECT, mode: 'allow' }
    ])
  })

  it('已有同工具 + 同工作区的规则不重复加（写法归一后也算同一条）', async () => {
    const bridge = installKyclawBridge({
      ...defaultSettings(),
      permissions: { rules: [{ tool: 'write', workspace: 'd:/项目/demo', mode: 'allow' }] }
    })
    await store().load()

    await store().allowToolForever('write', PROJECT)

    expect(store().settings.permissions.rules).toHaveLength(1)
    expect(bridge.update).toHaveBeenCalledWith({
      permissions: { rules: [{ tool: 'write', workspace: 'd:/项目/demo', mode: 'allow' }] }
    })
  })

  it('落盘失败抛给调用方（审批卡据此把"没保存"露出来），store 不假装写成功', async () => {
    const bridge = installKyclawBridge(defaultSettings())
    bridge.update.mockRejectedValueOnce(new Error('磁盘满了'))

    await expect(store().allowToolForever('write', PROJECT)).rejects.toThrow('磁盘满了')

    expect(store().settings.permissions.rules).toEqual([])
  })

  it('没有 preload 桥：抛"设置通道不可用"', async () => {
    clearKyclawBridge()

    await expect(store().allowToolForever('write', PROJECT)).rejects.toThrow(/设置通道不可用/)
  })
})

describe('settings store · round 20 置顶与归档', () => {
  const snapshot = {
    threadId: 't1',
    title: '会话一',
    projectId: 'p1',
    archivedAt: '2026-10-11T12:00:00.000Z'
  }

  it('setPinnedThreads：整表替换 pinnedThreads，以落盘回吐为准', async () => {
    const bridge = installKyclawBridge()

    await store().setPinnedThreads(['t1', 't2'])

    expect(bridge.update).toHaveBeenCalledWith({ pinnedThreads: ['t1', 't2'] })
    expect(store().settings.pinnedThreads).toEqual(['t1', 't2'])
  })

  it('archiveThread：写快照并从置顶里摘掉同一条；store 跟着落盘结果走', async () => {
    const initial = { ...defaultSettings(), pinnedThreads: ['t1', 't2'] }
    const bridge = installKyclawBridge(initial)
    useSettingsStore.setState({ settings: initial, loaded: true })

    await store().archiveThread(snapshot)

    expect(bridge.update).toHaveBeenCalledWith({
      archivedThreads: [snapshot],
      pinnedThreads: ['t2']
    })
    expect(store().settings.archivedThreads).toEqual([snapshot])
    expect(store().settings.pinnedThreads).toEqual(['t2'])
  })

  it('archiveThread：重复归档同一条是覆盖（不留两行）', async () => {
    const second = { ...snapshot, title: '改过标题', archivedAt: '2026-10-12T08:00:00.000Z' }
    const initial = { ...defaultSettings(), archivedThreads: [snapshot] }
    installKyclawBridge(initial)
    useSettingsStore.setState({ settings: initial, loaded: true })

    await store().archiveThread(second)

    expect(store().settings.archivedThreads).toEqual([second])
  })

  it('unarchiveThread：过滤掉这条（没有归档过是幂等空操作）', async () => {
    const other = { ...snapshot, threadId: 't9' }
    const initial = { ...defaultSettings(), archivedThreads: [snapshot, other] }
    const bridge = installKyclawBridge(initial)
    useSettingsStore.setState({ settings: initial, loaded: true })

    await store().unarchiveThread('t1')
    expect(store().settings.archivedThreads).toEqual([other])

    await store().unarchiveThread('不存在')
    expect(store().settings.archivedThreads).toEqual([other])
    expect(bridge.update).toHaveBeenLastCalledWith({ archivedThreads: [other] })
  })

  it('失败抛给调用方（侧栏/归档栏据此露一行），没有 preload 桥也抛', async () => {
    const bridge = installKyclawBridge()
    bridge.update.mockRejectedValueOnce(new Error('设置落盘失败'))
    await expect(store().setPinnedThreads(['t1'])).rejects.toThrow('设置落盘失败')

    clearKyclawBridge()
    await expect(store().archiveThread(snapshot)).rejects.toThrow(/设置通道不可用/)
    await expect(store().unarchiveThread('t1')).rejects.toThrow(/设置通道不可用/)
  })
})

describe('settings store · round 22 模型元数据探测', () => {
  it('probeModels：以主进程回吐的设置为准（probedModels 进 store）', async () => {
    const bridge = installKyclawBridge()
    bridge.probeModels.mockResolvedValueOnce({
      ...defaultSettings(),
      probedModels: {
        'ds:m': { contextWindow: 1_048_576, fetchedAt: '2026-10-11T00:00:00.000Z' }
      }
    })

    await store().probeModels('ds')

    expect(bridge.probeModels).toHaveBeenCalledWith('ds')
    expect(store().settings.probedModels['ds:m']?.contextWindow).toBe(1_048_576)
  })

  it('probeModels：失败静默（只记日志，不抛、不动现有元数据）', async () => {
    const bridge = installKyclawBridge()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    bridge.probeModels.mockRejectedValueOnce(new Error('ipc 断了'))

    await expect(store().probeModels('ds')).resolves.toBeUndefined()
    expect(store().settings.probedModels).toEqual({})
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('probeModels：没有 preload 桥（浏览器 / 单测环境）→ 空操作不抛', async () => {
    clearKyclawBridge()
    await expect(store().probeModels('ds')).resolves.toBeUndefined()
  })
})

describe('settings store · round 25 项目置顶与归档', () => {
  const snapshot = {
    projectId: 'p1',
    name: '项目一',
    path: 'D:\\p1',
    archivedAt: '2026-10-11T12:00:00.000Z'
  }

  it('setPinnedProjects：整表替换 pinnedProjects，以落盘回吐为准', async () => {
    const bridge = installKyclawBridge()

    await store().setPinnedProjects(['p1', 'p2'])

    expect(bridge.update).toHaveBeenCalledWith({ pinnedProjects: ['p1', 'p2'] })
    expect(store().settings.pinnedProjects).toEqual(['p1', 'p2'])
  })

  it('archiveProject：写快照并从置顶里摘掉同一个项目；重复归档是覆盖（不留两行）', async () => {
    const initial = { ...defaultSettings(), pinnedProjects: ['p1', 'p2'] }
    const bridge = installKyclawBridge(initial)
    useSettingsStore.setState({ settings: initial, loaded: true })

    await store().archiveProject(snapshot)

    expect(bridge.update).toHaveBeenCalledWith({
      archivedProjects: [snapshot],
      pinnedProjects: ['p2']
    })
    expect(store().settings.archivedProjects).toEqual([snapshot])
    expect(store().settings.pinnedProjects).toEqual(['p2'])

    const second = { ...snapshot, name: '改过名字', archivedAt: '2026-10-12T08:00:00.000Z' }
    await store().archiveProject(second)
    expect(store().settings.archivedProjects).toEqual([second])
  })

  it('unarchiveProject：过滤掉这条（没有归档过是幂等空操作）', async () => {
    const other = { ...snapshot, projectId: 'p9' }
    const initial = { ...defaultSettings(), archivedProjects: [snapshot, other] }
    const bridge = installKyclawBridge(initial)
    useSettingsStore.setState({ settings: initial, loaded: true })

    await store().unarchiveProject('p1')
    expect(store().settings.archivedProjects).toEqual([other])

    await store().unarchiveProject('不存在')
    expect(store().settings.archivedProjects).toEqual([other])
    expect(bridge.update).toHaveBeenLastCalledWith({ archivedProjects: [other] })
  })

  it('失败抛给调用方（侧栏/归档栏据此露一行），没有 preload 桥也抛', async () => {
    const bridge = installKyclawBridge()
    bridge.update.mockRejectedValueOnce(new Error('设置落盘失败'))
    await expect(store().setPinnedProjects(['p1'])).rejects.toThrow('设置落盘失败')

    clearKyclawBridge()
    await expect(store().archiveProject(snapshot)).rejects.toThrow(/设置通道不可用/)
    await expect(store().unarchiveProject('p1')).rejects.toThrow(/设置通道不可用/)
  })
})
