import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../../shared/settings'
import { readSettings, settingsPath, updateSettings, writeSettings } from '../settings'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kyclaw-settings-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('设置存储（userData 下的 settings.json）', () => {
  it('往返：写进去什么就读出来什么', () => {
    const file = settingsPath(dir)
    const settings = {
      theme: 'dark' as const,
      fontTier: 'large' as const,
      providers: [],
      workspaces: []
    }

    writeSettings(file, settings)

    expect(readSettings(file)).toEqual(settings)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(settings)
  })

  it('没有落过盘（首启动）→ 默认值', () => {
    expect(readSettings(settingsPath(dir))).toEqual(DEFAULT_SETTINGS)
  })

  it('文件不是 JSON（写坏/被改）→ 默认值，不抛', () => {
    const file = settingsPath(dir)
    writeFileSync(file, '{不是 json', 'utf8')

    expect(readSettings(file)).toEqual(DEFAULT_SETTINGS)
  })

  it('字段过不了 schema（非法主题 / 缺键 / 多键）→ 整个文件当没写过（默认值），不抛', () => {
    const file = settingsPath(dir)

    for (const bad of [
      { ...DEFAULT_SETTINGS, theme: 'blue' },
      { theme: 'dark', fontTier: 'large' },
      { ...DEFAULT_SETTINGS, evil: 1 }
    ]) {
      writeFileSync(file, JSON.stringify(bad), 'utf8')
      expect(readSettings(file), JSON.stringify(bad)).toEqual(DEFAULT_SETTINGS)
    }
  })

  it('读出来的默认值是新的（含新数组），调用方改了不污染模块级默认', () => {
    const first = readSettings(settingsPath(dir))
    first.providers.push({ id: 'leaked' })
    first.workspaces.push({ path: 'D:/leaked' })

    expect(DEFAULT_SETTINGS.providers).toEqual([])
    expect(DEFAULT_SETTINGS.workspaces).toEqual([])
  })

  it('目录还不存在时写入会自己建目录（userData 首次创建）', () => {
    const file = settingsPath(join(dir, 'nested', 'deeper'))

    writeSettings(file, { ...DEFAULT_SETTINGS, theme: 'light' })

    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ theme: 'light' })
  })

  it('写不进去就抛（磁盘满/路径被占），不静默吞掉用户的改动', () => {
    // 父路径是个文件 → mkdir 必失败
    const blocked = join(dir, 'blocked')
    writeFileSync(blocked, 'x', 'utf8')

    expect(() => writeSettings(settingsPath(blocked), DEFAULT_SETTINGS)).toThrow()
  })
})

describe('updateSettings（打补丁 → 合并 → 校验 → 落盘）', () => {
  it('只改补丁里的字段，其余保持原值，并把合并结果落盘', () => {
    const file = settingsPath(dir)
    writeSettings(file, { ...DEFAULT_SETTINGS, fontTier: 'small' })

    const next = updateSettings(file, { theme: 'dark' })

    expect(next).toEqual({ ...DEFAULT_SETTINGS, theme: 'dark', fontTier: 'small' })
    expect(readSettings(file)).toEqual(next)
  })

  it('文件还没写过时打补丁：以默认值为底再合并', () => {
    const file = settingsPath(dir)

    expect(updateSettings(file, { fontTier: 'large' })).toEqual({
      ...DEFAULT_SETTINGS,
      fontTier: 'large'
    })
  })

  it('补丁取值不合法就抛，且文件保持原样（拒绝半落盘）', () => {
    const file = settingsPath(dir)
    writeSettings(file, { ...DEFAULT_SETTINGS, theme: 'light' })

    // 直接调函数时（没走 IPC 闸门）也要拦住：schema 是最后一道
    expect(() => updateSettings(file, { theme: 'blue' } as unknown as { theme: 'dark' })).toThrow()
    expect(readSettings(file)).toEqual({ ...DEFAULT_SETTINGS, theme: 'light' })
  })
})
