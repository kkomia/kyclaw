import { describe, expect, it, vi } from 'vitest'
import { trayMenuTemplate } from '../tray-menu'

/**
 * 托盘菜单（T16 走查补测）：文案与动作钉住。
 * 托盘图标本身是 OS 级东西（Win11 溢出面板展开才能目视），自动化只能钉到这里 ——
 * 图标文件与 shell 注册证据见 `smoke-t16/`（Windows 通知区注册表快照 + 走查文档 T1）。
 */
function labelsOf(template: ReturnType<typeof trayMenuTemplate>): string[] {
  return template.map((item) => (item.type === 'separator' ? '---' : (item.label ?? '')))
}

describe('托盘菜单模板', () => {
  it('三项：显示主窗口 / 分隔 / 退出 kyclaw（文案照产品名）', () => {
    expect(labelsOf(trayMenuTemplate({ show: vi.fn(), quit: vi.fn() }))).toEqual([
      '显示主窗口',
      '---',
      '退出 kyclaw'
    ])
  })

  it('点「显示主窗口」走 show；点「退出 kyclaw」走 quit（不交叉）', () => {
    const show = vi.fn()
    const quit = vi.fn()
    const template = trayMenuTemplate({ show, quit })

    ;(template[0].click as () => void)()
    expect(show).toHaveBeenCalledTimes(1)
    expect(quit).not.toHaveBeenCalled()

    ;(template[2].click as () => void)()
    expect(quit).toHaveBeenCalledTimes(1)
    expect(show).toHaveBeenCalledTimes(1)
  })
})
