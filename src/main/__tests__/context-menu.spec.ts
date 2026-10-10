import { describe, expect, it, vi } from 'vitest'

/**
 * 客户端内右键菜单（雷点 4）：模板只由我们认的项组成，且按编辑态 / 选区给档。
 * 这里只测纯函数（模板构造）；挂事件与 popup 在 attachContextMenu 里，靠真窗口验。
 */
vi.mock('electron', () => ({
  Menu: { buildFromTemplate: vi.fn() }
}))

import { contextMenuTemplate, type ContextMenuActions } from '../context-menu'

const ALL_FLAGS = {
  canCut: true,
  canCopy: true,
  canPaste: true,
  canSelectAll: true,
  canUndo: true,
  canRedo: true,
  canDelete: true,
  canEditRichly: true
}

function actions(): ContextMenuActions {
  return { cut: vi.fn(), copy: vi.fn(), paste: vi.fn(), selectAll: vi.fn() }
}

function labelsOf(template: ReturnType<typeof contextMenuTemplate>): string[] {
  return template.map((item) => (item.type === 'separator' ? '---' : (item.label ?? '')))
}

describe('右键菜单模板', () => {
  it('编辑区：剪切 / 复制 / 粘贴 / 分隔 / 全选，禁用的项跟着 editFlags 走', () => {
    const acts = actions()
    const template = contextMenuTemplate(
      { isEditable: true, selectionText: '', editFlags: ALL_FLAGS },
      acts
    )

    expect(labelsOf(template)).toEqual(['剪切', '复制', '粘贴', '---', '全选'])

    const copy = template.find((item) => item.label === '复制')
    copy?.click?.(undefined as never, undefined as never, undefined as never)
    expect(acts.copy).toHaveBeenCalledTimes(1)
  })

  it('编辑区没选区：复制灰着（不撒谎，也不给空动作）', () => {
    const template = contextMenuTemplate(
      {
        isEditable: true,
        selectionText: '',
        editFlags: { ...ALL_FLAGS, canCopy: false, canCut: false }
      },
      actions()
    )

    expect(template.find((item) => item.label === '复制')?.enabled).toBe(false)
    expect(template.find((item) => item.label === '剪切')?.enabled).toBe(false)
    expect(template.find((item) => item.label === '粘贴')?.enabled).toBe(true)
  })

  it('非编辑区有选中文字：只给复制 / 全选', () => {
    const template = contextMenuTemplate(
      { isEditable: false, selectionText: '选中的一段话', editFlags: ALL_FLAGS },
      actions()
    )

    expect(labelsOf(template)).toEqual(['复制', '全选'])
  })

  it('非编辑区没有选中：不弹（浏览器自带项没有入口）', () => {
    const template = contextMenuTemplate(
      { isEditable: false, selectionText: '   ', editFlags: { ...ALL_FLAGS, canCopy: false } },
      actions()
    )

    expect(template).toEqual([])
  })

  it('任何一档都不含浏览器默认项（查看源代码 / 检查元素 / 另存为 / 刷新）', () => {
    const forbidden = ['查看源代码', '检查', '另存为', '刷新', '重新加载', '打印', '后退']
    for (const isEditable of [true, false]) {
      const template = contextMenuTemplate(
        { isEditable, selectionText: '文本', editFlags: ALL_FLAGS },
        actions()
      )
      for (const label of labelsOf(template)) {
        expect(
          forbidden.some((word) => label.includes(word)),
          label
        ).toBe(false)
      }
    }
  })
})
