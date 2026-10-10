import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Button } from '../button'
import { Menu, type MenuEntry } from '../menu'
import { tick } from './tick'

const items: MenuEntry[] = [
  { id: 'rename', label: '重命名' },
  { id: 'delete', label: '删除', danger: true },
  { id: 'sep', type: 'separator' },
  { id: 'archive', label: '归档', icon: <svg data-testid="archive-icon" /> },
  { id: 'pin', label: '置顶', disabled: true }
]

function renderMenu(
  entries: MenuEntry[] = items,
  onSelect = vi.fn()
): { onSelect: typeof onSelect } {
  render(
    <Menu
      trigger={<Button variant="ghost">会话菜单</Button>}
      items={entries.map((entry) => (entry.type === 'separator' ? entry : { ...entry, onSelect }))}
    />
  )
  return { onSelect }
}

function openByKeyboard(): HTMLElement {
  const trigger = screen.getByRole('button', { name: '会话菜单' })
  fireEvent.keyDown(trigger, { key: 'ArrowDown' })
  return trigger
}

describe('Menu', () => {
  it('触发元素拿到 Radix 的菜单语义（aria-haspopup / aria-expanded）', () => {
    renderMenu()

    const trigger = screen.getByRole('button', { name: '会话菜单' })
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')

    openByKeyboard()
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
  })

  it('键盘打开：面板底 Bg-Tertiary、内边距 8、圆角 20（§7 菜单值）', () => {
    renderMenu()
    openByKeyboard()

    const menu = screen.getByRole('menu')
    expect(menu).toHaveClass(
      'bg-menu',
      'p-(--menu-pad)',
      'rounded-overlay',
      'shadow-(--shadow-overlay)'
    )
  })

  it('无遮罩：菜单打开时页面上没有蒙层（§7 实测：面板外区域与打开前完全一致）', () => {
    renderMenu()
    openByKeyboard()

    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(document.querySelector('.bg-mask')).toBeNull()
  })

  it('条目：高 36、项圆角 10、hover 底 Fills-F1、B2 字号（§7）', () => {
    renderMenu()
    openByKeyboard()

    const rename = screen.getByRole('menuitem', { name: '重命名' })
    expect(rename).toHaveClass(
      'h-(--menu-item-height)',
      'rounded-(--menu-item-radius)',
      'data-[highlighted]:bg-hover',
      'text-b2',
      'text-ink',
      'px-2'
    )
  })

  it('危险条目用红字 + 危险浅底高亮；图标位按 18 走', () => {
    renderMenu()
    openByKeyboard()

    expect(screen.getByRole('menuitem', { name: '删除' })).toHaveClass(
      'text-danger',
      'data-[highlighted]:bg-danger-bg'
    )

    const archive = screen.getByRole('menuitem', { name: '归档' })
    expect(archive.querySelector('span[aria-hidden="true"]')).toHaveClass('size-(--icon-size-md)')
    expect(screen.getByTestId('archive-icon')).toBeInTheDocument()
  })

  it('分隔条目渲染成 separator，禁用条目带 data-disabled 与禁用文字档', () => {
    renderMenu()
    openByKeyboard()

    expect(screen.getByRole('separator')).toHaveClass('bg-hairline')
    expect(screen.getByRole('menuitem', { name: '置顶' })).toHaveAttribute('data-disabled')
    expect(screen.getByRole('menuitem', { name: '置顶' })).toHaveClass(
      'data-[disabled]:text-(--text-disabled)'
    )
  })

  it('键盘选择：方向键在条目间移动，回车触发 onSelect 并关面板', async () => {
    const { onSelect } = renderMenu()
    openByKeyboard()

    const rename = screen.getByRole('menuitem', { name: '重命名' })
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(rename)

    fireEvent.keyDown(rename, { key: 'ArrowDown' })
    await tick()
    const remove = screen.getByRole('menuitem', { name: '删除' })
    expect(document.activeElement).toBe(remove)

    fireEvent.keyDown(remove, { key: 'Enter' })

    expect(onSelect).toHaveBeenCalledWith('delete')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('禁用条目不可被选中（键盘扫描跳过它）', () => {
    const { onSelect } = renderMenu([
      { id: 'pin', label: '置顶', disabled: true },
      { id: 'rename', label: '重命名' }
    ])
    openByKeyboard()

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'ArrowDown' })
    const rename = screen.getByRole('menuitem', { name: '重命名' })
    expect(document.activeElement).toBe(rename)

    fireEvent.keyDown(rename, { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith('rename')
  })

  it('Esc 关闭，并把焦点还给触发元素', async () => {
    renderMenu()
    const trigger = openByKeyboard()

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    await tick()

    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(document.activeElement).toBe(trigger)
  })

  it('鼠标打开：pointerdown 也能开（标题栏/工具栏的常规路径）', async () => {
    renderMenu()
    const trigger = screen.getByRole('button', { name: '会话菜单' })

    // Radix 的"点外关闭"监听在下一个宏任务里才挂上，开之前先让事件循环转一圈
    await new Promise((resolve) => setTimeout(resolve, 0))
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })

    expect(screen.getByRole('menu')).toBeInTheDocument()
  })
})

describe('Menu · 子菜单（round 7）', () => {
  const submenu: MenuEntry[] = [
    { id: 'file', label: '添加文件', testId: 'menu-add-file' },
    { id: 'sep', type: 'separator' },
    {
      id: 'skills',
      type: 'submenu',
      label: '引用技能',
      testId: 'menu-ref-skills',
      items: [
        { id: 'read', label: '读取文件', testId: 'menu-ref-read' },
        { id: 'write', label: '写入文件', testId: 'menu-ref-write' }
      ]
    }
  ]

  function renderSubmenu(onSelect = vi.fn()): { onSelect: typeof onSelect } {
    render(
      <Menu
        trigger={<Button variant="ghost">菜单</Button>}
        items={submenu.map((entry) =>
          entry.type === 'separator'
            ? entry
            : entry.type === 'submenu'
              ? { ...entry, items: entry.items.map((item) => ({ ...item, onSelect })) }
              : { ...entry, onSelect }
        )}
      />
    )
    return { onSelect }
  }

  it('子菜单触发器有 menu 语义与展开箭头；ArrowRight 展开、子项可选中', async () => {
    const { onSelect } = renderSubmenu()
    fireEvent.keyDown(screen.getByRole('button', { name: '菜单' }), { key: 'ArrowDown' })

    const skills = screen.getByTestId('menu-ref-skills')
    expect(skills).toHaveAttribute('aria-haspopup', 'menu')
    expect(skills.querySelector('svg[aria-hidden="true"]')).not.toBeNull()

    skills.focus()
    fireEvent.keyDown(skills, { key: 'ArrowRight' })
    await tick()

    const read = screen.getByTestId('menu-ref-read')
    expect(read).toBeInTheDocument()
    read.focus()
    fireEvent.keyDown(read, { key: 'Enter' })

    expect(onSelect).toHaveBeenCalledWith('read')
  })

  it('子菜单条目为空 → 由调用方给一条禁用项，且不可选中', async () => {
    const onSelect = vi.fn()
    render(
      <Menu
        trigger={<Button variant="ghost">菜单</Button>}
        items={[
          {
            id: 'plugins',
            type: 'submenu',
            label: '引用插件',
            testId: 'menu-ref-plugins',
            items: [{ id: 'empty', label: '没有已启用的插件', disabled: true, onSelect }]
          }
        ]}
      />
    )
    fireEvent.keyDown(screen.getByRole('button', { name: '菜单' }), { key: 'ArrowDown' })

    const plugins = screen.getByTestId('menu-ref-plugins')
    plugins.focus()
    fireEvent.keyDown(plugins, { key: 'ArrowRight' })
    await tick()

    const item = screen.getByRole('menuitem', { name: '没有已启用的插件' })
    expect(item).toHaveAttribute('data-disabled')
    fireEvent.keyDown(item, { key: 'Enter' })
    expect(onSelect).not.toHaveBeenCalled()
  })
})
