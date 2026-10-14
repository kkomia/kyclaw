import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultSettings, appSettingsPatchSchema } from '../../shared/settings'
import { readSettings, updateSettings } from '../settings'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it('globalRules 旧文件迁移为空并保留初始化标志，保存清空原子持久化', () => {
  const root = mkdtempSync(join(tmpdir(), 'rules-settings-'))
  roots.push(root)
  const file = join(root, 'settings.json')
  const old: Record<string, unknown> = {
    ...defaultSettings(),
    theme: 'dark',
    defaultWorkspaceInitialized: true
  }
  delete old.globalRules
  writeFileSync(file, JSON.stringify(old))
  expect(readSettings(file)).toMatchObject({
    globalRules: '',
    theme: 'dark',
    defaultWorkspaceInitialized: true
  })
  updateSettings(file, { globalRules: '你好😀' })
  expect(readSettings(file).globalRules).toBe('你好😀')
  const before = readFileSync(file, 'utf8')
  expect(() => updateSettings(file, { globalRules: '中'.repeat(5462) })).toThrow()
  expect(readFileSync(file, 'utf8')).toBe(before)
  updateSettings(file, { globalRules: '' })
  expect(readSettings(file)).toMatchObject({ globalRules: '', defaultWorkspaceInitialized: true })
})

describe('globalRules schema', () => {
  it('UTF-8 字节上限而非字符上限且拒绝非法文本', () => {
    expect(appSettingsPatchSchema.safeParse({ globalRules: 'a'.repeat(16384) }).success).toBe(true)
    for (const globalRules of ['中'.repeat(5462), '\0', '\uD800']) {
      expect(appSettingsPatchSchema.safeParse({ globalRules }).success).toBe(false)
    }
    expect(appSettingsPatchSchema.parse({})).toEqual({})
  })
})
