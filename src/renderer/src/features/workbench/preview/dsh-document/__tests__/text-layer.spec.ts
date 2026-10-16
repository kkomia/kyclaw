import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PDFPageProxy, PageViewport } from 'pdfjs-dist'
import { pdfTextRenderer } from '../text-layer'

/** 文字层替身：记下每次 render 的入参、cancel 次数，div 与真件同名同类。 */
type FakeTextLayer = { div: HTMLDivElement; renders: unknown[]; cancels: number }

const mocks = vi.hoisted(() => {
  const created: FakeTextLayer[] = []
  class TextLayerBuilder {
    readonly div = document.createElement('div')
    readonly renders: unknown[] = []
    cancels = 0
    constructor() {
      this.div.className = 'textLayer'
      created.push(this)
    }
    render(options: unknown): Promise<void> {
      this.renders.push(options)
      return Promise.resolve()
    }
    cancel(): void {
      this.cancels += 1
      this.div.replaceChildren()
    }
  }
  return { created, TextLayerBuilder }
})

vi.mock('pdfjs-dist/web/pdf_viewer.mjs', () => ({ TextLayerBuilder: mocks.TextLayerBuilder }))

// 真模块在 jsdom 里会做一堆环境探测，这里只关心"取引擎 → 挂 globalThis.pdfjsLib"这一步
vi.mock('pdfjs-dist', () => ({ GlobalWorkerOptions: { workerSrc: '' } }))

/** 视口替身：只有 scale / userUnit / width 被用到（真件还有一堆别的方法）。 */
function fakeViewport(width: number, scale = 96 / 72): PageViewport {
  return { scale, userUnit: 1, width } as unknown as PageViewport
}

const PAGE = {} as unknown as PDFPageProxy

/** 造一个"宽度可调"的宿主（jsdom 不排版，几何得自己铺）。 */
function hostWithWidth(initial: number): {
  host: HTMLDivElement
  setWidth: (width: number) => void
} {
  let width = initial
  const host = document.createElement('div')
  Object.defineProperty(host, 'getBoundingClientRect', {
    configurable: true,
    value: (): DOMRect => ({ width }) as unknown as DOMRect
  })
  document.body.append(host)
  return { host, setWidth: (next: number) => (width = next) }
}

beforeEach(() => {
  mocks.created.length = 0
})

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

describe('pdfTextRenderer：可选中文字层', () => {
  // 这条必须留在文件最前：pdfjs 引擎只挂一次（模块缓存的 promise），后面再断言就看不到"从无到有"
  it('装 web 层之前先把引擎挂上 globalThis.pdfjsLib（pdf_viewer 在模块求值期就要它）', async () => {
    const global = globalThis as { pdfjsLib?: unknown }
    expect(global.pdfjsLib).toBeUndefined()

    const { host } = hostWithWidth(400)
    const task = pdfTextRenderer(host)(PAGE, fakeViewport(800))
    await task.promise

    expect(global.pdfjsLib).toBeDefined()
    task.cancel()
  })

  it('把文字层挂进宿主，并按视口与画布宽比定比例；cancel 收掉 DOM', async () => {
    const { host } = hostWithWidth(400)
    const viewport = fakeViewport(800)

    const task = pdfTextRenderer(host)(PAGE, viewport)
    await task.promise
    const layer = mocks.created[0]

    expect(layer?.div.className).toBe('textLayer')
    expect(host.querySelector('.textLayer')).toBe(layer?.div)
    // 字号口径：--total-scale-factor = 视口 scale × userUnit（pdf.js 的 --text-scale-factor 就是它乘出来的）
    expect(layer?.div.style.getPropertyValue('--total-scale-factor')).toBe(String(96 / 72))
    // 比例 = 宿主宽 ÷ 视口宽（400 / 800）
    expect(layer?.div.style.getPropertyValue('scale')).toBe('0.5')
    expect(layer?.renders).toEqual([{ viewport }])

    task.cancel()

    expect(host.querySelector('.textLayer')).toBeNull()
    expect(layer?.cancels).toBe(1)
  })

  it('量不到宽度（未布局 / jsdom）时不写 scale：不把整层文字缩成看不见', async () => {
    const { host } = hostWithWidth(0)

    await pdfTextRenderer(host)(PAGE, fakeViewport(800)).promise

    expect(mocks.created[0]?.div.style.getPropertyValue('scale')).toBe('')
  })

  it('宿主变宽：观察器回调里跟着改比例（文字层与重画后的位图对齐）', async () => {
    const callbacks: Array<() => void> = []
    const observers: Array<{ disconnected: boolean }> = []
    class FakeResizeObserver {
      readonly record = { disconnected: false }
      observed = 0
      constructor(callback: () => void) {
        callbacks.push(callback)
        observers.push(this.record)
      }
      observe(): void {
        this.observed += 1
      }
      disconnect(): void {
        this.record.disconnected = true
      }
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)

    const { host, setWidth } = hostWithWidth(400)
    const task = pdfTextRenderer(host)(PAGE, fakeViewport(800))
    await task.promise
    const layer = mocks.created[0]
    expect(layer?.div.style.getPropertyValue('scale')).toBe('0.5')

    setWidth(600)
    callbacks[0]?.()
    expect(layer?.div.style.getPropertyValue('scale')).toBe('0.75')

    task.cancel()
    expect(observers[0]?.disconnected).toBe(true)
  })

  it('没有 ResizeObserver 的环境也能用（只少一次跟着变宽，不是错误）', async () => {
    vi.stubGlobal('ResizeObserver', undefined)
    const { host } = hostWithWidth(400)

    const task = pdfTextRenderer(host)(PAGE, fakeViewport(800))
    await task.promise

    expect(host.querySelector('.textLayer')).not.toBeNull()
    task.cancel()
  })

  it('取消得比 import 早也算数：不留文字层、不抛错', async () => {
    const { host } = hostWithWidth(400)

    const task = pdfTextRenderer(host)(PAGE, fakeViewport(800))
    task.cancel()
    await task.promise

    expect(host.querySelector('.textLayer')).toBeNull()
  })
})
