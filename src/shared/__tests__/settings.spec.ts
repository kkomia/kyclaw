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
  it('默认值：跟随系统 / 默认字号 / providers 与 workspaces 为空数组 / 权限规则为空', () => {
    expect(DEFAULT_SETTINGS).toEqual({
      theme: 'system',
      fontTier: 'default',
      providers: [],
      workspaces: [],
      permissions: { rules: [] }
    })
    expect(appSettingsSchema.parse(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS)
  })

  it('落盘文件名固定为 settings.json（与窗口状态的 window-state.json 分开）', () => {
    expect(SETTINGS_FILE).toBe('settings.json')
  })

  it('defaultSettings() 每次给新对象（含新数组），改返回值不污染模块级默认', () => {
    const first = defaultSettings()
    first.theme = 'dark'
    first.providers.push({ id: 'leaked', type: 'anthropic', model: 'm', isDefault: false })

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

  it('providers 元素过不了 provider schema（错 type / 缺 id / 夹带明文 apiKey）→ 整份设置按坏文件处理', () => {
    for (const bad of [
      [{ id: 'x', type: 'gemini', model: 'm', isDefault: false }],
      [{ type: 'anthropic', model: 'm', isDefault: false }],
      [{ id: 'x', type: 'anthropic', model: 'm', isDefault: false, apiKey: 'sk-leaked' }]
    ]) {
      expect(
        appSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, providers: bad }).success,
        JSON.stringify(bad)
      ).toBe(false)
    }
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

describe('工作区 schema（T10：授权目录 = path + mode）', () => {
  it('元素必须是 {path, mode}，mode 只收 ask / full', () => {
    for (const mode of ['ask', 'full'] as const) {
      const workspaces = [{ path: 'D:\\项目\\demo', mode }]
      expect(appSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, workspaces }).success, mode).toBe(
        true
      )
    }

    for (const bad of [
      [{ path: 'D:\\ws' }], // 缺 mode
      [{ mode: 'ask' }], // 缺 path
      [{ path: '', mode: 'ask' }], // 空路径
      [{ path: 'D:\\ws', mode: 'always' }], // 非法模式
      [{ path: 'D:\\ws', mode: 'ask', extra: 1 }] // 多键
    ]) {
      expect(
        appSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, workspaces: bad }).success,
        JSON.stringify(bad)
      ).toBe(false)
    }
  })

  it('补丁 schema 里没有 workspaces：授权目录只能走 workspace:* 通道改（路径要在主进程过原生选择器与校验）', () => {
    expect(appSettingsPatchSchema.safeParse({ workspaces: [] }).success).toBe(false)
    expect(
      appSettingsPatchSchema.safeParse({ workspaces: [{ path: 'D:\\ws', mode: 'full' }] }).success
    ).toBe(false)
    expect(appSettingsPatchSchema.parse({ theme: 'dark' })).toEqual({ theme: 'dark' })
  })
})

describe('权限规则 schema（T13：审批记忆的"永久允许"）', () => {
  it('元素必须是 {tool, workspace, mode:"allow"}，粒度 = 工具 + 工作区', () => {
    const rules = [{ tool: 'write', workspace: 'D:\\项目\\demo', mode: 'allow' }]
    expect(
      appSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, permissions: { rules } }).success
    ).toBe(true)

    for (const bad of [
      { rules: [{ tool: 'write', workspace: 'D:\\ws' }] }, // 缺 mode
      { rules: [{ tool: '', workspace: 'D:\\ws', mode: 'allow' }] }, // 空工具名
      { rules: [{ tool: 'write', workspace: '', mode: 'allow' }] }, // 空工作区
      { rules: [{ tool: 'write', workspace: 'D:\\ws', mode: 'deny' }] }, // 只有 allow 会落盘
      { rules: [{ tool: 'write', workspace: 'D:\\ws', mode: 'allow', extra: 1 }] }, // 多键
      { rules: 'D:\\ws' }, // 不是数组
      {} // 缺 rules
    ]) {
      expect(
        appSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, permissions: bad }).success,
        JSON.stringify(bad)
      ).toBe(false)
    }
  })

  it('补丁可以整表替换规则（审批卡的"永久允许"走这条路），但形状必须合法', () => {
    const permissions = { rules: [{ tool: 'edit', workspace: 'D:\\ws', mode: 'allow' }] }
    expect(appSettingsPatchSchema.parse({ permissions })).toEqual({ permissions })
    expect(
      appSettingsPatchSchema.safeParse({ permissions: { rules: [{ tool: 'edit' }] } }).success
    ).toBe(false)
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
