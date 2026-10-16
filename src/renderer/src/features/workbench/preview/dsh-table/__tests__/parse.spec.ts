import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExcelPreviewError } from '../errors'
import { EXCEL_LIMITS } from '../model'
import { parseExcel } from '../parse'

/**
 * 解析入口的四条硬口径：
 *   - **超限先拒**：字节数越过 `maxBytes` 时根本不建 Worker；
 *   - **严格隔离**：环境里没有 Worker（jsdom 就没有）或 Worker 起不来，一律回可重试的 `worker` 失败，
 *     **不退回主线程**——不可信的大文件不能阻塞 UI，同线程也真掐不断；
 *   - **失败种类**：超时 `timeout`、坏回包 `invalid`、Worker 不可用 `worker`，界面按种类说人话；
 *   - **中断即释放**：成功 / 失败 / 超时 / abort 四条路都要 `terminate()` 并摘掉回调（不留残余计算）。
 */
const csv = (text: string): Uint8Array => new TextEncoder().encode(text)

/** Worker 替身：记下构造、消息与是否被终止 */
class FakeWorker {
  static instances: FakeWorker[] = []
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  onmessageerror: ((event: unknown) => void) | null = null
  terminated = false
  readonly posted: Array<{ bytes: Uint8Array; format: string }> = []

  constructor() {
    FakeWorker.instances.push(this)
  }

  postMessage(message: { bytes: Uint8Array; format: string }): void {
    this.posted.push(message)
  }

  terminate(): void {
    this.terminated = true
  }

  /** 从 Worker 那侧回一条消息 */
  reply(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent<unknown>)
  }
}

/** validPreview 认的最小结果 */
const validPreview = {
  sheets: [{ name: 'CSV', celldata: [] }],
  missingResults: 0,
  unsupportedFeatures: []
}

/** 失败种类（顺便把"抛的不是 ExcelPreviewError"也照实说出来） */
async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (error) {
    return error instanceof ExcelPreviewError ? error.code : `other:${String(error)}`
  }
  return 'no-error'
}

function stubFakeWorker(): void {
  FakeWorker.instances = []
  vi.stubGlobal('Worker', FakeWorker as unknown as typeof Worker)
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('parseExcel：上限与 Worker 隔离', () => {
  it('字节数越过 maxBytes → tooLarge，且根本不建 Worker', async () => {
    stubFakeWorker()
    const controller = new AbortController()
    const limits = { ...EXCEL_LIMITS, maxBytes: 2 }
    expect(await codeOf(() => parseExcel(csv('a,b\n'), 'csv', limits, controller.signal))).toBe(
      'tooLarge'
    )
    expect(FakeWorker.instances).toHaveLength(0)
  })

  it('环境里没有 Worker（jsdom）→ 可重试的 worker 失败，**不在主线程偷解**', async () => {
    // jsdom 不实现 Worker；这里显式钉住"没有 Worker 就是失败"，不是退回同线程
    vi.stubGlobal('Worker', undefined)
    const controller = new AbortController()
    expect(
      await codeOf(() =>
        parseExcel(csv('姓名,年龄\n张三,28\n'), 'csv', EXCEL_LIMITS, controller.signal)
      )
    ).toBe('worker')
  })

  it('Worker 构造就抛（起不来）→ 同样是可重试的 worker 失败', async () => {
    vi.stubGlobal(
      'Worker',
      class {
        constructor() {
          throw new Error('no worker here')
        }
      }
    )
    const controller = new AbortController()
    expect(
      await codeOf(() => parseExcel(csv('a,b\n'), 'csv', EXCEL_LIMITS, controller.signal))
    ).toBe('worker')
  })

  it('字节交给 Worker 的是**拷贝**（转移走的是自己那份，调用方的数组不动）', async () => {
    stubFakeWorker()
    const bytes = csv('a,b\n')
    const controller = new AbortController()
    const pending = parseExcel(bytes, 'csv', EXCEL_LIMITS, controller.signal)
    const worker = FakeWorker.instances[0]
    const posted = worker?.posted[0]
    expect(posted?.bytes).not.toBe(bytes)
    expect(Array.from(posted?.bytes ?? [])).toEqual(Array.from(bytes))
    worker?.reply({ ok: true, value: validPreview })
    await expect(pending).resolves.toEqual(validPreview)
  })
})

describe('parseExcel：回包与失败种类', () => {
  it('Worker 正常回包 → 出结果，并且立刻终止 Worker、摘掉回调', async () => {
    stubFakeWorker()
    const controller = new AbortController()
    const pending = parseExcel(csv('a\n'), 'csv', EXCEL_LIMITS, controller.signal)
    const worker = FakeWorker.instances[0]
    worker?.reply({ ok: true, value: validPreview })

    await expect(pending).resolves.toEqual(validPreview)
    expect(worker?.terminated).toBe(true)
    expect(worker?.onmessage).toBeNull()
    expect(worker?.onerror).toBeNull()
    expect(worker?.onmessageerror).toBeNull()
  })

  it('Worker 报错（加载失败这类）→ worker 失败 + 终止', async () => {
    stubFakeWorker()
    const controller = new AbortController()
    const pending = parseExcel(csv('a\n'), 'csv', EXCEL_LIMITS, controller.signal)
    const worker = FakeWorker.instances[0]
    worker?.onerror?.(new Event('error'))

    await expect(pending).rejects.toMatchObject({ code: 'worker' })
    expect(worker?.terminated).toBe(true)
  })

  it('回包形状不对 → invalid（不放行半个结果）', async () => {
    stubFakeWorker()
    const controller = new AbortController()
    const pending = parseExcel(csv('a\n'), 'csv', EXCEL_LIMITS, controller.signal)
    const worker = FakeWorker.instances[0]
    // 认不出的失败种类：白名单之外
    worker?.reply({ ok: false, code: 'nonsense' })

    await expect(pending).rejects.toMatchObject({ code: 'invalid' })
    expect(worker?.terminated).toBe(true)
  })

  it('Worker 自己报的失败种类照原样带出来（tooLarge / encoding 这类）', async () => {
    stubFakeWorker()
    const controller = new AbortController()
    const pending = parseExcel(csv('a\n'), 'csv', EXCEL_LIMITS, controller.signal)
    FakeWorker.instances[0]?.reply({ ok: false, code: 'encoding' })

    await expect(pending).rejects.toMatchObject({ code: 'encoding' })
  })
})

describe('parseExcel：超时与中断都要释放 Worker', () => {
  it('到点没回包 → timeout + 终止', async () => {
    stubFakeWorker()
    const controller = new AbortController()
    const limits = { ...EXCEL_LIMITS, timeoutMs: 10 }
    const pending = parseExcel(csv('a\n'), 'csv', limits, controller.signal)
    const worker = FakeWorker.instances[0]

    await expect(pending).rejects.toMatchObject({ code: 'timeout' })
    expect(worker?.terminated).toBe(true)
  })

  it('abort → AbortError + **立刻终止 Worker**（不等着它把活干完）', async () => {
    stubFakeWorker()
    const controller = new AbortController()
    const pending = parseExcel(csv('a\n'), 'csv', EXCEL_LIMITS, controller.signal)
    const worker = FakeWorker.instances[0]

    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(worker?.terminated).toBe(true)
    expect(worker?.onmessage).toBeNull()
  })

  it('调用前就 abort → 直接拒，不建 Worker', async () => {
    stubFakeWorker()
    const controller = new AbortController()
    controller.abort()
    await expect(
      parseExcel(csv('a\n'), 'csv', EXCEL_LIMITS, controller.signal)
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(FakeWorker.instances).toHaveLength(0)
  })
})
