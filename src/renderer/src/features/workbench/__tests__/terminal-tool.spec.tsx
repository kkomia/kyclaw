import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkbenchRoot } from '../use-workbench-root'
import { setupWorkbench, teardownWorkbench, type Bed } from './bed'

/**
 * 终端工具：xterm 与 FitAddon 在这里被替身顶掉（真 PTY 由 Electron 探针验），
 * 验的是渲染端与主进程的接线：起会话的时机与参数、输出推送的落点、退出提示、重启与卸载的清算。
 */
const mocks = vi.hoisted(() => {
  interface FakeTerminalInstance {
    cols: number
    rows: number
    options: Record<string, unknown>
    write: ReturnType<typeof vi.fn>
    dispose: ReturnType<typeof vi.fn>
    focus: ReturnType<typeof vi.fn>
    reset: ReturnType<typeof vi.fn>
    open: ReturnType<typeof vi.fn>
    loadAddon: ReturnType<typeof vi.fn>
    onData: ReturnType<typeof vi.fn>
    emitInput: (data: string) => void
  }
  return {
    instances: [] as FakeTerminalInstance[],
    fits: [] as Array<{ fit: ReturnType<typeof vi.fn> }>
  }
})

vi.mock('@xterm/xterm', () => {
  class Terminal {
    cols = 80
    rows = 24
    options: Record<string, unknown>
    write = vi.fn()
    dispose = vi.fn()
    focus = vi.fn()
    reset = vi.fn()
    open = vi.fn()
    loadAddon = vi.fn()
    private inputCallback: (data: string) => void = () => {}
    constructor(options: Record<string, unknown>) {
      this.options = options
      mocks.instances.push(this as never)
    }
    onData(callback: (data: string) => void): { dispose: () => void } {
      this.inputCallback = callback
      return { dispose: () => undefined }
    }
    emitInput(data: string): void {
      this.inputCallback(data)
    }
  }
  return { Terminal }
})

vi.mock('@xterm/addon-fit', () => {
  class FitAddon {
    fit = vi.fn()
    constructor() {
      mocks.fits.push(this as never)
    }
  }
  return { FitAddon }
})

import { TerminalTool } from '../TerminalTool'

let bed: Bed

function rootOf(): WorkbenchRoot {
  return {
    threadId: 'thread-1',
    rootPath: 'D:\\工作区',
    rootName: '工作区',
    ready: true,
    settling: false,
    notice: null,
    workbench: bed.bridge.workbench,
    terminal: bed.bridge.terminal
  }
}

beforeEach(() => {
  bed = setupWorkbench()
  mocks.instances.length = 0
  mocks.fits.length = 0
  // jsdom 里容器没有真实尺寸：让 clientWidth/Height 非 0，fit 才会真的跑
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 320 })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: 240 })
})

afterEach(() => {
  teardownWorkbench()
  vi.unstubAllGlobals()
  document.documentElement.style.removeProperty('--font-code')
})

describe('TerminalTool', () => {
  it('挂载即建 xterm 并起会话（尺寸来自 FitAddon 量出来的 cols/rows）', async () => {
    render(<TerminalTool root={rootOf()} active />)

    await waitFor(() => expect(bed.bridge.terminal.start).toHaveBeenCalledWith('thread-1', 80, 24))
    expect(mocks.instances[0]?.open).toHaveBeenCalled()
    expect(screen.getByTestId('terminal-screen')).toBeInTheDocument()
  })

  it('键盘输入写进 PTY（带当前会话 id）', async () => {
    render(<TerminalTool root={rootOf()} active />)
    await waitFor(() => expect(bed.bridge.terminal.start).toHaveBeenCalled())

    mocks.instances[0]?.emitInput('ls\n')
    await waitFor(() => expect(bed.bridge.terminal.write).toHaveBeenCalledWith('term-1', 'ls\n'))
  })

  it('主进程推来的输出写进 xterm；退出的那一段另给一行提示', async () => {
    render(<TerminalTool root={rootOf()} active />)
    await waitFor(() => expect(bed.bridge.terminal.start).toHaveBeenCalled())

    bed.bridge.terminal.push('term-1', 'PTY-OK\r\n')
    expect(mocks.instances[0]?.write).toHaveBeenCalledWith('PTY-OK\r\n')

    bed.bridge.terminal.exit('term-1', 0)
    expect(mocks.instances[0]?.write).toHaveBeenCalledWith('\r\n[已结束：退出码 0]\r\n')
    await waitFor(() => expect(screen.getByTestId('terminal-status')).toHaveTextContent('已结束'))
  })

  it('重启：先关掉老会话再起一个新的', async () => {
    render(<TerminalTool root={rootOf()} active />)
    await waitFor(() => expect(bed.bridge.terminal.start).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByTestId('terminal-restart'))

    await waitFor(() => expect(bed.bridge.terminal.dispose).toHaveBeenCalledWith('term-1'))
    await waitFor(() => expect(bed.bridge.terminal.start).toHaveBeenCalledTimes(2))
  })

  it('卸载（应用收尾）：退订 + 关掉会话 + 释放 xterm', async () => {
    const { unmount } = render(<TerminalTool root={rootOf()} active />)
    await waitFor(() => expect(bed.bridge.terminal.start).toHaveBeenCalled())

    unmount()

    expect(bed.bridge.terminal.dispose).toHaveBeenCalledWith('term-1')
    expect(mocks.instances[0]?.dispose).toHaveBeenCalled()
  })

  it('起会话失败：露一句人话，不留假终端', async () => {
    bed.bridge.terminal.start.mockRejectedValue(
      new Error('终端组件加载失败（node-pty）：was compiled against a different Node.js version')
    )
    render(<TerminalTool root={rootOf()} active />)

    expect(await screen.findByTestId('terminal-error')).toHaveTextContent(
      '终端组件加载失败（node-pty）'
    )
  })

  it('切回本 tab 会重新 fit 并同步尺寸', async () => {
    const { rerender } = render(<TerminalTool root={rootOf()} active={false} />)
    await waitFor(() => expect(bed.bridge.terminal.start).toHaveBeenCalled())
    const before = mocks.fits[0]?.fit.mock.calls.length ?? 0

    rerender(<TerminalTool root={rootOf()} active />)

    await waitFor(() => expect(mocks.fits[0]?.fit.mock.calls.length ?? 0).toBeGreaterThan(before))
    expect(bed.bridge.terminal.resize).toHaveBeenCalledWith('term-1', 80, 24)
    expect(mocks.instances[0]?.focus).toHaveBeenCalled()
  })

  it('xterm 字体读 --font-code（含 DSH 中文链）；token 缺失时退回章程逐字串，不再硬编码 Geist', async () => {
    const original = window.getComputedStyle.bind(window)
    const token =
      "'Cascadia Mono', 'Cascadia Code', Consolas, 'Noto Sans SC', 'PingFang SC', monospace"
    const spy = vi.spyOn(window, 'getComputedStyle').mockImplementation((element: Element) => {
      if (element === document.documentElement) {
        return {
          getPropertyValue: (name: string): string => (name === '--font-code' ? token : '')
        } as CSSStyleDeclaration
      }
      return original(element)
    })

    const first = render(<TerminalTool root={rootOf()} active />)
    await waitFor(() => expect(bed.bridge.terminal.start).toHaveBeenCalled())
    // 直接拿 token 的计算值当 xterm fontFamily（CSS 变量值本身就是合法的 fontFamily 串）
    expect(String(mocks.instances[0]?.options.fontFamily)).toBe(token)
    first.unmount()
    spy.mockRestore()

    // 读不到 token（独立渲染 / 极端启动时序）：退回章程逐字串（中文链含 Noto Sans SC/雅黑）
    mocks.instances.length = 0
    mocks.fits.length = 0
    bed.bridge.terminal.start.mockClear()
    render(<TerminalTool root={rootOf()} active />)
    await waitFor(() => expect(mocks.instances.length).toBe(1))
    const fallback = String(mocks.instances[0]?.options.fontFamily)
    expect(fallback).toContain('Cascadia Mono')
    expect(fallback).toContain('Noto Sans SC')
    expect(fallback).toContain('Microsoft YaHei')
    // 旧硬编码（Geist/ui-monospace）不能再出现
    expect(fallback).not.toContain('Geist')
    expect(fallback).not.toContain('ui-monospace')
  })
})
