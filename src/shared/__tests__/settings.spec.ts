import { describe, expect, it } from 'vitest'
import {
  appSettingsPatchSchema,
  appSettingsSchema,
  DEFAULT_SETTINGS,
  defaultSettings,
  SETTINGS_FILE
} from '../settings'

/**
 * 设置 schema（shared/settings.ts）：主进程落盘、IPC 入参、渲染端消费共用这一份。
 * 这里盯两件事：默认值就是文档写的那四个字段；非法取值一个都不放过。
 */
describe('AppSettings schema', () => {
  it('默认值：跟随系统 / 默认字号 / providers 与 workspaces 为空数组', () => {
    expect(DEFAULT_SETTINGS).toEqual({
      theme: 'system',
      fontTier: 'default',
      providers: [],
      workspaces: []
    })
    expect(appSettingsSchema.parse(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS)
  })

  it('落盘文件名固定为 settings.json（与窗口状态的 window-state.json 分开）', () => {
    expect(SETTINGS_FILE).toBe('settings.json')
  })

  it('defaultSettings() 每次给新对象（含新数组），改返回值不污染模块级默认', () => {
    const first = defaultSettings()
    first.theme = 'dark'
    first.providers.push({ id: 'leaked' })

    expect(DEFAULT_SETTINGS.theme).toBe('system')
    expect(DEFAULT_SETTINGS.providers).toEqual([])
    expect(defaultSettings()).toEqual(DEFAULT_SETTINGS)
  })

  it('主题只收 system / light / dark，字号只收 small / default / large', () => {
    expect(appSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, theme: 'light' }).success).toBe(true)
    expect(appSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, theme: 'dark' }).success).toBe(true)
    expect(appSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, fontTier: 'small' }).success).toBe(
      true
    )
    expect(appSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, fontTier: 'large' }).success).toBe(
      true
    )

    for (const bad of ['blue', 'System', '', 'darkk']) {
      expect(appSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, theme: bad }).success, bad).toBe(
        false
      )
    }
    for (const bad of ['huge', 'big', 'Default', 1]) {
      expect(
        appSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, fontTier: bad }).success,
        String(bad)
      ).toBe(false)
    }
  })

  it('providers / workspaces 必须是数组（对象与字符串都不合法）', () => {
    expect(appSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, providers: {} }).success).toBe(false)
    expect(appSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, workspaces: 'D:/x' }).success).toBe(
      false
    )
  })

  it('缺键与多键都不合法（strict：落盘文件的字段集合就是 schema 的字段集合）', () => {
    expect(appSettingsSchema.safeParse({ theme: 'system' }).success).toBe(false)
    expect(appSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, fontTier: undefined }).success).toBe(
      false
    )
    expect(appSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, extra: 1 }).success).toBe(false)
    expect(appSettingsSchema.safeParse(null).success).toBe(false)
  })
})

describe('AppSettings 补丁 schema（settings:update 的入参）', () => {
  it('只给要改的字段就是合法补丁（空补丁也合法，等于不改）', () => {
    expect(appSettingsPatchSchema.parse({ theme: 'dark' })).toEqual({ theme: 'dark' })
    expect(appSettingsPatchSchema.parse({})).toEqual({})
    expect(appSettingsPatchSchema.parse({ fontTier: 'large', providers: [] })).toEqual({
      fontTier: 'large',
      providers: []
    })
  })

  it('非法取值 / 多余键 / 非对象都拒绝', () => {
    expect(appSettingsPatchSchema.safeParse({ theme: 'blue' }).success).toBe(false)
    expect(appSettingsPatchSchema.safeParse({ fontTier: 'huge' }).success).toBe(false)
    expect(appSettingsPatchSchema.safeParse({ evil: 1 }).success).toBe(false)
    expect(appSettingsPatchSchema.safeParse('dark').success).toBe(false)
    expect(appSettingsPatchSchema.safeParse(null).success).toBe(false)
  })
})
