import { beforeEach, describe, expect, it } from 'vitest'
import { useSessionsStore } from '@renderer/features/sessions/sessions-store'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { resetWorkbenchStore, useWorkbenchStore } from '../workbench-store'
import { absoluteOf } from '../use-workbench-root'
import { formatBytes, formatDateTime, formatLineStat, refTone, splitRefs } from '../format'
import { describeLoadError, normalizeUrl } from '../webview-element'
import { defaultSettings } from '@shared/settings'

beforeEach(() => {
  resetWorkbenchStore()
  useSessionsStore.setState({ activeId: null })
  useSettingsStore.setState({ settings: defaultSettings() })
})

describe('workbench-store：tab 选择与保活', () => {
  it('默认停在文件；切到别的 tab 会把新 tab 加进挂载集合，切回来不重复', () => {
    expect(useWorkbenchStore.getState().activeTab).toBe('files')
    expect(useWorkbenchStore.getState().mounted).toEqual(['files'])

    useWorkbenchStore.getState().select('terminal')
    expect(useWorkbenchStore.getState().activeTab).toBe('terminal')
    expect(useWorkbenchStore.getState().mounted).toEqual(['files', 'terminal'])

    useWorkbenchStore.getState().select('browser')
    useWorkbenchStore.getState().select('terminal')
    expect(useWorkbenchStore.getState().mounted).toEqual(['files', 'terminal', 'browser'])
    expect(useWorkbenchStore.getState().activeTab).toBe('terminal')
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
