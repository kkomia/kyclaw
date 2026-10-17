// @vitest-environment node
/**
 * 托盘的"全活"创建（0.1.3 托盘驻留）：成功 = 工具提示 / 菜单 / 单击都在；失败 = 明确返回 null
 * 且半成品销毁（调用方据此把"关闭到托盘"整条关掉，见 main/__tests__/window-close.spec.ts 的
 * "托盘不可用 → 放行"）。
 *
 * tray.ts 本体不在这里测：它 import 的 `icon.png?asset` 是 electron-vite 的查询，vitest 解析不了
 * ——真件（Tray 构造 + 真图标 + 真系统托盘）由 e2e 探针覆盖。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { MenuItemConstructorOptions, Tray } from 'electron'

vi.mock('electron', () => ({
  Menu: { buildFromTemplate: vi.fn((template: unknown) => ({ template })) }
}))

import { attachTray } from '../tray-setup'

/** 假托盘：记下挂上来的东西，可以指定在哪一步抛（模拟系统托盘不可用 / 资源坏） */
interface FakeTray {
  tooltip: string
  menu: unknown
  click: (() => void) | null
  destroyed: number
  setToolTip(text: string): void
  setContextMenu(menu: unknown): void
  on(event: string, listener: () => void): void
  destroy(): void
}

function fakeTray(failAt: 'setToolTip' | 'setContextMenu' | 'on' | null = null): FakeTray {
  const tray: FakeTray = {
    tooltip: '',
    menu: null as unknown,
    click: null as (() => void) | null,
    destroyed: 0,
    setToolTip(text: string): void {
      if (failAt === 'setToolTip') throw new Error('setToolTip 失败')
      tray.tooltip = text
    },
    setContextMenu(menu: unknown): void {
      if (failAt === 'setContextMenu') throw new Error('setContextMenu 失败')
      tray.menu = menu
    },
    on(event: string, listener: () => void): void {
      if (failAt === 'on') throw new Error('on 失败')
      if (event === 'click') tray.click = listener
    },
    destroy(): void {
      tray.destroyed += 1
    }
  }
  return tray
}

const MENU: MenuItemConstructorOptions[] = [
  { label: '显示主窗口' },
  { type: 'separator' },
  { label: '退出 kyclaw' }
]

/** 失败留痕：只记 console.warn 被叫过几次（实现细节不钉，钉"有痕"） */
const warns: unknown[][] = []

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warns.push(args)
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  warns.length = 0
})

describe('attachTray：建好 / 失败两种下场', () => {
  it('成功：返回托盘，工具提示、右键菜单、单击都挂上（菜单走 buildFromTemplate）', () => {
    const tray = fakeTray()
    const onClick = vi.fn()

    const attached = attachTray({
      create: () => tray as unknown as Tray,
      tooltip: 'kyclaw',
      menu: MENU,
      onClick
    })

    expect(attached).toBe(tray)
    expect(tray.tooltip).toBe('kyclaw')
    expect((tray.menu as { template: unknown }).template).toEqual(MENU)
    expect(tray.destroyed).toBe(0)
    expect(warns).toEqual([])

    // 单击托盘图标 → 交给调用方（显示主窗口）
    tray.click?.()
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('构造就抛（系统托盘不可用）：返回 null，不把异常抛给启动流程，也没有半成品可销毁', () => {
    expect(() =>
      attachTray({
        create: () => {
          throw new Error('没有状态通知宿主')
        },
        tooltip: 'kyclaw',
        menu: MENU,
        onClick: vi.fn()
      })
    ).not.toThrow()
    expect(warns.length).toBe(1)
  })

  it('半途失败（菜单挂不上）：返回 null 并销毁半成品——半残入口不许留下', () => {
    const tray = fakeTray('setContextMenu')

    const attached = attachTray({
      create: () => tray as unknown as Tray,
      tooltip: 'kyclaw',
      menu: MENU,
      onClick: vi.fn()
    })

    expect(attached).toBeNull()
    expect(tray.destroyed).toBe(1)
    expect(warns.length).toBe(1)
  })

  it('单击也挂不上（on 抛）：同样返回 null 并销毁半成品', () => {
    const tray = fakeTray('on')

    const attached = attachTray({
      create: () => tray as unknown as Tray,
      tooltip: 'kyclaw',
      menu: MENU,
      onClick: vi.fn()
    })

    expect(attached).toBeNull()
    expect(tray.destroyed).toBe(1)
    expect(warns.length).toBe(1)
  })
})
