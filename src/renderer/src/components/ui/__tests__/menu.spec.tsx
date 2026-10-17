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

  it('键盘打开：紧凑 panel（360 上限 / 内边距 6 / 圆角 12 / hairline + shadow）', () => {
    renderMenu()
    openByKeyboard()

    const menu = screen.getByRole('menu')
    expect(menu).toHaveClass(
      'bg-menu',
      'p-1',
      'rounded-[10px]',
      'border-hairline',
      'w-[min(360px,calc(100vw-24px))]',
      'shadow-(--shadow-overlay)'
    )
  })

  it('无遮罩：菜单打开时页面上没有蒙层（§7 实测：面板外区域与打开前完全一致）', () => {
    renderMenu()
    openByKeyboard()

    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(document.querySelector('.bg-mask')).toBeNull()
  })

  it('条目：单行 40、项圆角 8、hover 底 Fills-F1、B2 字号', () => {
    renderMenu()
    openByKeyboard()

    const rename = screen.getByRole('menuitem', { name: '重命名' })
    expect(rename).toHaveClass(
      'min-h-[32px]',
      'rounded-[8px]',
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
    // task-73：行图标随字号 scale（--icon-size-sm token），不再写死 size-4
    expect(archive.querySelector('span[aria-hidden="true"]')).toHaveClass('size-(--icon-size-sm)')
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

  it('trailing 数值走 code 声部 + tabular；文字类 trailing 保持 sans（task-64 字体一致性）', async () => {
    render(
      <Menu
        trigger={<Button variant="ghost">菜单</Button>}
        items={[
          { id: 'model', label: '选择模型', trailing: '128K' },
          { id: 'effort', label: '思考强度', trailing: '标准' },
          { id: 'pct', label: '对话长度', trailing: '85%' }
        ]}
      />
    )
    fireEvent.keyDown(screen.getByRole('button', { name: '菜单' }), { key: 'ArrowDown' })
    await tick()

    const numeric = screen.getByText('128K')
    expect(numeric).toHaveClass('font-mono', 'tabular-nums')
    expect(screen.getByText('85%')).toHaveClass('font-mono', 'tabular-nums')
    // 文字标签（思考挡位这类）不因为挨着数值就变 mono
    const label = screen.getByText('标准')
    expect(label).not.toHaveClass('font-mono')
    expect(label).toHaveClass('text-c1')
  })
})

/**
 * task-61 · 紧凑菜单原语：分组标题 / 两行（icon+标题+描述）/ 右侧 meta/badge/选中对勾。
 * 规格来自 `.superpowers/chat-aesthetics/refs/ref-model-dropdown.png`、`ref-slash-menu.png`。
 */
describe('Menu · 紧凑行 / 分组 / meta', () => {
  it('分组标题 11/500 tertiary；组内行可带 description（两行 48）与 icon', () => {
    render(
      <Menu
        trigger={<Button variant="ghost">模型菜单</Button>}
        items={[
          {
            id: 'deepseek',
            type: 'group',
            label: 'DeepSeek Account',
            items: [
              {
                id: 'v4',
                label: 'DeepSeek V4',
                description: 'deepseek-v4',
                icon: <svg data-testid="model-icon" />,
                testId: 'menu-model-v4'
              }
            ]
          }
        ]}
      />
    )
    fireEvent.keyDown(screen.getByRole('button', { name: '模型菜单' }), { key: 'ArrowDown' })

    const group = screen.getByTestId('menu-group-deepseek')
    expect(group).toHaveTextContent('DeepSeek Account')
    expect(group.querySelector('[role="menuitem"]')).toHaveClass('min-h-10', 'items-start')
    const item = screen.getByTestId('menu-model-v4')
    expect(item).toHaveTextContent('DeepSeek V4')
    expect(item).toHaveTextContent('deepseek-v4')
    expect(item.querySelector('[data-testid="model-icon"]')).not.toBeNull()
  })

  it('右侧 badge 走 mono 11 tabular 小胶囊；选中项有对勾且 aria-current=page', () => {
    render(
      <Menu
        trigger={<Button variant="ghost">模型菜单</Button>}
        items={[
          {
            id: 'v4',
            label: 'DeepSeek V4',
            description: '默认模型',
            badge: '128K',
            selected: true,
            testId: 'menu-model-v4'
          }
        ]}
      />
    )
    fireEvent.keyDown(screen.getByRole('button', { name: '模型菜单' }), { key: 'ArrowDown' })

    const item = screen.getByTestId('menu-model-v4')
    expect(item).toHaveAttribute('aria-current', 'page')
    expect(item).toHaveClass('bg-selected')
    const badge = item.querySelector('span.font-mono')
    expect(badge).not.toBeNull()
    expect(badge).toHaveTextContent('128K')
    expect(badge).toHaveClass('text-[10px]', 'tabular-nums')
    expect(item.querySelector('svg')).not.toBeNull() // Check 对勾
  })
})
