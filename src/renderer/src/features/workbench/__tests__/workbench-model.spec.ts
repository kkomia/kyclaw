import { beforeEach, describe, expect, it } from 'vitest'
import { useSessionsStore } from '@renderer/features/sessions/sessions-store'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { resetWorkbenchStore, browserTabTitle, useWorkbenchStore } from '../workbench-store'
import { absoluteOf } from '../use-workbench-root'
import { formatBytes, formatDateTime, formatLineStat, refTone, splitRefs } from '../format'
import { describeLoadError, normalizeUrl } from '../webview-element'
import { defaultSettings } from '@shared/settings'

beforeEach(() => {
  resetWorkbenchStore()
  useSessionsStore.setState({ activeId: null })
  useSettingsStore.setState({ settings: defaultSettings() })
})

describe('workbench-store：标签页模型', () => {
  it('默认一个「文件」标签；文件/Git 复用，浏览器/终端每次新开', () => {
    const initial = useWorkbenchStore.getState()
    expect(initial.tabs.map((tab) => tab.kind)).toEqual(['files'])
    expect(initial.activeTabId).toBe(initial.tabs[0]?.id)

    useWorkbenchStore.getState().openTab('terminal')
    useWorkbenchStore.getState().openTab('terminal')
    useWorkbenchStore.getState().openTab('browser')
    useWorkbenchStore.getState().openTab('browser')
    let tabs = useWorkbenchStore.getState().tabs
    expect(tabs.map((tab) => tab.kind)).toEqual([
      'files',
      'terminal',
      'terminal',
      'browser',
      'browser'
    ])
    // 新开的那个是当前标签
    expect(useWorkbenchStore.getState().activeTabId).toBe(tabs[4]?.id)

    // 文件 / Git 是世界状态：已开着就只激活，不重复开
    useWorkbenchStore.getState().openTab('git')
    useWorkbenchStore.getState().openTab('git')
    useWorkbenchStore.getState().openTab('files')
    tabs = useWorkbenchStore.getState().tabs
    expect(tabs.filter((tab) => tab.kind === 'files')).toHaveLength(1)
    expect(tabs.filter((tab) => tab.kind === 'git')).toHaveLength(1)
    expect(useWorkbenchStore.getState().activeTabId).toBe(tabs[0]?.id)
  })

  it('关标签：接左边的邻居；全关光 = 空态（activeTabId 空串）；未知 id 不误伤', () => {
    const { openTab, closeTab, selectTab } = useWorkbenchStore.getState()
    openTab('terminal')
    openTab('git')
    const [files, terminal, git] = useWorkbenchStore.getState().tabs
    if (files === undefined || terminal === undefined || git === undefined) {
      throw new Error('三个标签没开出来')
    }

    selectTab(terminal.id)
    // 关掉不是当前的那个：当前标签不动
    closeTab(files.id)
    expect(useWorkbenchStore.getState().tabs.map((tab) => tab.id)).toEqual([terminal.id, git.id])
    expect(useWorkbenchStore.getState().activeTabId).toBe(terminal.id)

    // 关掉当前标签：接到左边那个（terminal 左边没东西 → 接右边的 git）
    closeTab(terminal.id)
    expect(useWorkbenchStore.getState().activeTabId).toBe(git.id)

    closeTab('没这个标签')
    expect(useWorkbenchStore.getState().tabs.map((tab) => tab.id)).toEqual([git.id])
    selectTab('也没这个')
    expect(useWorkbenchStore.getState().activeTabId).toBe(git.id)

    closeTab(git.id)
    expect(useWorkbenchStore.getState().tabs).toEqual([])
    expect(useWorkbenchStore.getState().activeTabId).toBe('')
  })

  it('resetWorkbench：回默认单「文件」；浏览器标题按页面标题 → 主机名 → 兜底名', () => {
    useWorkbenchStore.getState().openTab('browser')
    const browser = useWorkbenchStore.getState().tabs[1]
    if (browser === undefined) throw new Error('浏览器标签没开出来')
    useWorkbenchStore.getState().setTabTitle(browser.id, '示例站点')
    expect(useWorkbenchStore.getState().tabs[1]?.title).toBe('示例站点')

    useWorkbenchStore.getState().resetWorkbench()
    const tabs = useWorkbenchStore.getState().tabs
    expect(tabs.map((tab) => tab.kind)).toEqual(['files'])
    expect(useWorkbenchStore.getState().activeTabId).toBe(tabs[0]?.id)

    expect(browserTabTitle('页面标题', 'https://a.b/c')).toBe('页面标题')
    expect(browserTabTitle('   ', 'https://example.com/a?b=1')).toBe('example.com')
    expect(browserTabTitle('', 'about:blank')).toBe('浏览器')
    expect(browserTabTitle('', '不是网址')).toBe('浏览器')
  })
})

describe('显示口径（纯函数）', () => {
  it('formatBytes：B 不带小数、其余一位小数', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(999)).toBe('999 B')
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(1024 * 1024 * 3)).toBe('3.0 MB')
  })

  it('formatDateTime：ISO → 本地 YYYY-MM-DD HH:mm；解析不了原样回', () => {
    expect(formatDateTime('2026-10-11T09:05:00+08:00')).toMatch(/^2026-10-11 \d{2}:05$/)
    expect(formatDateTime('不是时间')).toBe('不是时间')
  })

  it('refs 拆分与配色：tag 高亮、HEAD 强调、远程次要', () => {
    expect(splitRefs('HEAD -> main, tag: v1.0, origin/main')).toEqual([
      'HEAD -> main',
      'tag: v1.0',
      'origin/main'
    ])
    expect(refTone('tag: v1.0')).toBe('text-warning')
    expect(refTone('HEAD -> main')).toBe('text-accent-text')
    expect(refTone('origin/main')).toBe('text-ink-tertiary')
    expect(splitRefs('')).toEqual([])
  })

  it('formatLineStat：二进制两列都给 null', () => {
    expect(formatLineStat(3, 1)).toBe('+3 −1')
    expect(formatLineStat(null, null)).toBe('二进制')
  })
})

describe('browser 的纯函数', () => {
  it('normalizeUrl：补协议、本机用 http、已带协议原样', () => {
    expect(normalizeUrl('example.com')).toBe('https://example.com')
    expect(normalizeUrl('http://a.b/c')).toBe('http://a.b/c')
    expect(normalizeUrl('https://a.b')).toBe('https://a.b')
    expect(normalizeUrl('localhost:5173')).toBe('http://localhost:5173')
    expect(normalizeUrl('  ')).toBeNull()
  })

  it('describeLoadError：常见错误码翻人话，认不出原样给 Chromium 描述', () => {
    expect(describeLoadError({ errorCode: -105, errorDescription: 'x' })).toContain('域名解析不了')
    expect(describeLoadError({ errorCode: -106, errorDescription: 'x' })).toContain('网络')
    expect(describeLoadError({ errorCode: -7, errorDescription: 'x' })).toContain('超时')
    expect(describeLoadError({ errorCode: -999, errorDescription: 'ERR_WEIRD' })).toContain(
      'ERR_WEIRD'
    )
  })
})

describe('absoluteOf：复制路径用的文本（Windows 反斜杠）', () => {
  it('根 + 相对路径拼成绝对路径；空相对路径就是根', () => {
    expect(absoluteOf('D:\\工作区', '')).toBe('D:\\工作区')
    expect(absoluteOf('D:\\工作区', 'src/a.ts')).toBe('D:\\工作区\\src\\a.ts')
    expect(absoluteOf('/home/me', 'src/a.ts')).toBe('/home/me/src/a.ts')
  })
})
