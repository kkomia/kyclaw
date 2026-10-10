import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Button } from '../button'
import { Dialog, DialogClose } from '../dialog'
import { tick } from './tick'

describe('Dialog', () => {
  it('点触发元素弹出：蒙层是 MaskBg-Base，面板圆角 20（§4.5 弹窗圆角）', () => {
    render(
      <Dialog trigger={<Button>打开</Button>} title="重命名会话">
        内容
      </Dialog>
    )

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '打开' }))

    expect(screen.getByRole('dialog')).toHaveClass(
      'rounded-overlay',
      'bg-(--bg-overlay)',
      'shadow-(--shadow-overlay)',
      'p-6',
      'max-w-(--overlay-max-width)'
    )
    expect(document.querySelector('.bg-mask')).toHaveClass('fixed', 'inset-0', 'z-50')
  })

  it('尺寸两档：small 360 / medium 560（§4.5 弹层尺寸档），默认 small', () => {
    const { rerender } = render(
      <Dialog open trigger={<Button>打开</Button>} title="小">
        内容
      </Dialog>
    )
    expect(screen.getByRole('dialog')).toHaveClass('w-(--overlay-width-sm)')

    rerender(
      <Dialog open size="md" trigger={<Button>打开</Button>} title="中">
        内容
      </Dialog>
    )
    expect(screen.getByRole('dialog')).toHaveClass('w-(--overlay-width-md)')
    expect(screen.getByRole('dialog')).not.toHaveClass('w-(--overlay-width-sm)')
  })

  it('标题与说明接进无障碍树（Radix 的 aria-labelledby / aria-describedby）', () => {
    render(
      <Dialog open trigger={<Button>打开</Button>} title="删除会话" description="删除后不可恢复">
        内容
      </Dialog>
    )

    const dialog = screen.getByRole('dialog')
    const title = screen.getByText('删除会话')
    const description = screen.getByText('删除后不可恢复')

    expect(title.tagName).toBe('H2')
    expect(dialog.getAttribute('aria-labelledby')).toBe(title.getAttribute('id'))
    expect(dialog.getAttribute('aria-describedby')).toBe(description.getAttribute('id'))
  })

  it('children 与 footer 分区渲染（footer 右对齐）', () => {
    render(
      <Dialog
        open
        trigger={<Button>打开</Button>}
        title="标题"
        footer={
          <>
            <Button variant="ghost">取消</Button>
            <Button>确定</Button>
          </>
        }
      >
        <p>正文</p>
      </Dialog>
    )

    const dialog = screen.getByRole('dialog')
    expect(screen.getByText('正文')).toBeInTheDocument()
    expect(screen.getByText('取消')).toBeInTheDocument()
    expect(screen.getByText('取消').parentElement).toHaveClass(
      'mt-6',
      'flex',
      'justify-end',
      'gap-2'
    )
    expect(dialog).toContainElement(screen.getByText('确定'))
  })

  it('Esc 关闭（受控用法回吐 onOpenChange）', async () => {
    const onOpenChange = vi.fn()
    render(
      <Dialog open onOpenChange={onOpenChange} trigger={<Button>打开</Button>} title="标题">
        内容
      </Dialog>
    )

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    await tick()

    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('点蒙层关闭（Radix 的"点外关闭"要等监听挂上，先 tick 再点）', async () => {
    function Harness(): React.JSX.Element {
      const [open, setOpen] = useState(true)
      return (
        <Dialog open={open} onOpenChange={setOpen} trigger={<Button>打开</Button>} title="标题">
          内容
        </Dialog>
      )
    }
    render(<Harness />)

    await tick()
    const overlay = document.querySelector('.bg-mask') as HTMLElement
    fireEvent.pointerDown(overlay, { button: 0, ctrlKey: false })
    fireEvent.click(overlay)
    await tick()

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('面板自己不吃焦点环：Content 带 outline-none（焦点由内部元素接管）', () => {
    render(
      <Dialog open trigger={<Button>打开</Button>} title="标题">
        内容
      </Dialog>
    )

    expect(screen.getByRole('dialog')).toHaveClass('outline-none')
  })
})

describe('DialogClose（受控用法的关闭钮）', () => {
  it('是图标按钮：36 高、图标 18、右上角、名字叫"关闭"', () => {
    render(
      <Dialog open trigger={<Button>打开</Button>} title="标题">
        <DialogClose />
      </Dialog>
    )

    const close = screen.getByRole('button', { name: '关闭' })
    expect(close).toHaveClass('size-(--icon-button-size)', 'absolute', 'top-3', 'right-3')
    expect(close.querySelector('span[aria-hidden="true"]')).toHaveClass('size-(--icon-size-md)')
  })

  it('点它走 onOpenChange(false)：受控用法下不自己管开合状态', async () => {
    function Harness(): React.JSX.Element {
      const [open, setOpen] = useState(true)
      return (
        <Dialog open={open} onOpenChange={setOpen} trigger={<Button>打开</Button>} title="标题">
          <DialogClose />
        </Dialog>
      )
    }
    render(<Harness />)

    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    await tick()

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('名字可覆盖（英文界面/不同语义的关闭钮）', () => {
    render(
      <Dialog open trigger={<Button>打开</Button>} title="标题">
        <DialogClose label="Close" />
      </Dialog>
    )

    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument()
  })
})
