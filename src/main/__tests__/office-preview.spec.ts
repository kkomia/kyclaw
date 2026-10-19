// @vitest-environment node
/**
 * 办公档页式预览后端（`src/main/office-preview.ts`）：队列准入 / 内容共享 / 缓存与别名上限 /
 * 源一致性 / 引擎适配 / 产出校验。
 *
 * 纪律（与 `office-legacy.spec.ts` 同口径）：
 *   - **一个真进程都不起**：子进程那层由 `run` 注入假件（注入件真的把 PDF 落到 `--output`）；
 *   - **一个真引擎都不碰**：kit 的 CLI 路径由 `kitCli` 注入（`render-ppt` 的解析被整份 mock 掉，
 *     单测的结论不跟着开发机有没有 `resources/libreoffice-kit` 变）；
 *   - **临时目录都是测试自建的**（`mkdtemp` 独有目录，收尾只删这些），不往共享临时目录里丢东西；
 *   - 源字节只是几个字节的假件（后端只把它们当"要交给引擎的字节"），产出用一份**真的最小 PDF**
 *    （头 `%PDF-1.7`、尾 `%%EOF` 都得过 `readPreviewPdf` 的闸门）。
 */
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_OFFICE_PREVIEW_CONFIG,
  OFFICE_PREVIEW_RUN_GRACE_MS,
  OFFICE_PREVIEW_TEMP_PREFIX,
  OfficePreview,
  OfficePreviewQueue,
  createOfficePreview,
  officePreviewSourceKey,
  officePreviewSourceVersion,
  readPreviewPdf,
  type OfficePreviewConfig,
  type OfficePreviewConversion,
  type OfficePreviewRequest,
  type OfficePreviewRunResult,
  type OfficePreviewRunSpec,
  type OfficePreviewRunner
} from '../office-preview'
import type { OfficePreviewPriority } from '../../shared/office-preview'

/** kit 的解析被整份 mock 掉：单测的结论不许跟着开发机装没装随包引擎变 */
const kit = vi.hoisted(() => ({ resolve: vi.fn<() => string | null>(() => null) }))
vi.mock('../tools/office-kit', () => ({ resolveKitCli: kit.resolve }))

const CLI = 'C:/fake/libreoffice-kit/cli.js'
/** 源字节：内容是什么不重要（后端不解析它），重要的是**同一个二进制不会被改** */
const INPUT = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x11, 0x22])
/** 一份真的最小 PDF（`readPreviewPdf` 认头认尾） */
const PDF = Buffer.from('%PDF-1.7\npreview\n%%EOF\n')
/** 字体根要**绝对路径**（这条用例断言的是开关怎么传，不是真有这个目录） */
const FONT_DIR = join(tmpdir(), 'kyclaw-preview-fonts')
/** 队列那一层的假产出（不需要是真 PDF：校验在引擎那一段） */
const OUTPUT = { pdf: Uint8Array.from([37, 80, 68, 70]), missingFonts: ['Font'] }

/** 测试自建的临时目录（`mkdtemp` 独有；收尾只删这些） */
const directories: string[] = []

beforeEach(() => {
  kit.resolve.mockReset()
  kit.resolve.mockReturnValue(null)
})

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'kyclaw-office-preview-spec-'))
  directories.push(directory)
  return directory
}

/** 注入的临时目录：先真的建一个，再把它记下来给断言用 */
function trackingTempDir(): () => Promise<string> {
  return async () => await tempDir()
}

/** 取一个"`--flag <值>`"开关后面的值 */
function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index < 0 ? undefined : args[index + 1]
}

/** 引擎成功的 stdout（那一行 JSON 就是缺字体名单的来源） */
function engineStdout(missingFonts: readonly string[] = ['缺失的字体']): string {
  return `${JSON.stringify({ backend: 'native', missingFonts, outputPath: 'preview.pdf' })}\n`
}

function okResult(): OfficePreviewRunResult {
  return { spawnError: null, aborted: false, timedOut: false, exitCode: 0, text: engineStdout() }
}

/**
 * 假引擎：把 spec 记下来，按 `--output` 落下一份 PDF（`pdf: null` = 故意不落，测"跑了但没产出"）。
 * `onRun` 是唯一能在"子进程还活着"的时候看现场（输入副本 / cwd / 参数）的机会。
 */
function pdfRunner(
  runs: OfficePreviewRunSpec[],
  options: {
    pdf?: Uint8Array | null
    result?: Partial<OfficePreviewRunResult>
    onRun?: (spec: OfficePreviewRunSpec) => Promise<void> | void
  } = {}
): OfficePreviewRunner {
  return async (spec) => {
    runs.push(spec)
    await options.onRun?.(spec)
    const output = flagValue(spec.args, '--output')
    const pdf = options.pdf === undefined ? PDF : options.pdf
    if (output !== undefined && pdf !== null) await writeFile(output, pdf)
    return { ...okResult(), ...options.result }
  }
}

function config(partial: Partial<OfficePreviewConfig> = {}): OfficePreviewConfig {
  return { ...DEFAULT_OFFICE_PREVIEW_CONFIG, ...partial }
}

/* ── 队列：准入、共享、缓存 ──────────────────────────────────────────────── */

interface QueueSource {
  read: ReturnType<typeof vi.fn<OfficePreviewRequest['source']['read']>>
  request: OfficePreviewRequest
}

function queueSource(
  key: string,
  byte = 1,
  priority: OfficePreviewPriority = 'foreground'
): QueueSource {
  const read = vi
    .fn<OfficePreviewRequest['source']['read']>()
    .mockResolvedValue({ bytes: new Uint8Array([byte]), version: 'v1' })
  const request: OfficePreviewRequest = {
    extension: 'docx',
    priority,
    source: { key: officePreviewSourceKey(key), version: 'v1', bytes: 1, read }
  }
  return { read, request }
}

/** 队列 + 假的转引擎（`convert` 的类型直接从构造函数取，与实现同一个类型） */
function queueHarness(partial: Partial<OfficePreviewConfig> = {}): {
  queue: OfficePreviewQueue
  convert: ReturnType<typeof vi.fn<ConstructorParameters<typeof OfficePreviewQueue>[2]>>
} {
  const convert = vi
    .fn<ConstructorParameters<typeof OfficePreviewQueue>[2]>()
    .mockResolvedValue(OUTPUT)
  const queue = new OfficePreviewQueue(config(partial), 'test-generation', convert)
  queues.push(queue)
  return { queue, convert }
}

/** 每个用例建过的队列（用例结束统一 dispose，别把在途作业留到下一个用例） */
const queues: OfficePreviewQueue[] = []
afterEach(async () => {
  for (const queue of queues.splice(0)) await queue.dispose()
})

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

describe('OfficePreviewQueue', () => {
  it('准入前不读字节，同一份内容只转一次并跨路径共享；每位读者拿独立字节', async () => {
    const h = queueHarness()
    const entered = deferred<undefined>()
    const complete = deferred<typeof OUTPUT>()
    h.convert.mockImplementationOnce(() => {
      entered.resolve(undefined)
      return complete.promise
    })
    const a = queueSource('a')
    const b = queueSource('b')
    const first = h.queue.read(a.request)
    await entered.promise
    const same = h.queue.read(a.request)
    const equalContent = h.queue.read(b.request)
    try {
      // b 与 a 的字节相同（同一个 digest）：并进来共享同一次转换，但**各自**读一次自己的源
      await vi.waitFor(() => expect(b.read).toHaveBeenCalledOnce())
      expect(a.read).toHaveBeenCalledOnce()
      expect(h.convert).toHaveBeenCalledOnce()
    } finally {
      complete.resolve(OUTPUT)
    }
    const results = await Promise.all([first, same, equalContent])
    expect(new Set(results.map((result) => result.cacheKey)).size).toBe(1)
    // 一位读者改自己的那份，不影响别人
    results[0].pdf[0] = 0
    results[0].missingFonts.length = 0
    expect(results[1].pdf).toEqual(OUTPUT.pdf)
    expect((await h.queue.read(b.request)).missingFonts).toEqual(['Font'])
    expect(b.read).toHaveBeenCalledOnce()
  })

  it('排队中的第一位读者取消后，后面的照跑（且不读已取消那位的字节）', async () => {
    const h = queueHarness({ maxConcurrentConversions: 1 })
    const entered = deferred<undefined>()
    const complete = deferred<typeof OUTPUT>()
    h.convert.mockImplementationOnce(() => {
      entered.resolve(undefined)
      return complete.promise
    })
    const first = h.queue.read(queueSource('active', 1).request)
    await entered.promise
    const cancelled = new AbortController()
    const second = queueSource('cancelled', 2)
    second.read.mockImplementation(async () => {
      cancelled.abort()
      return { bytes: new Uint8Array([2]), version: 'v1' }
    })
    const queued = h.queue.read(second.request, cancelled.signal)
    const rejected = expect(queued).rejects.toMatchObject({ name: 'AbortError' })
    const later = h.queue.read(queueSource('later', 3).request)
    try {
      expect(second.read).not.toHaveBeenCalled()
    } finally {
      complete.resolve(OUTPUT)
    }
    await first
    await rejected
    await expect(later).resolves.toMatchObject(OUTPUT)
    expect(second.read).toHaveBeenCalledOnce()
    expect(h.convert).toHaveBeenCalledTimes(2)
  })

  it('前台读者加入排队中的预热：升为前台、不额外读一次源', async () => {
    const h = queueHarness({ maxConcurrentConversions: 1 })
    const entered = deferred<undefined>()
    const complete = deferred<typeof OUTPUT>()
    h.convert.mockImplementationOnce(() => {
      entered.resolve(undefined)
      return complete.promise
    })
    const first = h.queue.read(queueSource('active', 1).request)
    await entered.promise
    const order: string[] = []
    const a = queueSource('a', 2, 'background')
    const b = queueSource('b', 3, 'background')
    a.read.mockImplementation(async () => {
      order.push('a')
      return { bytes: new Uint8Array([2]), version: 'v1' }
    })
    b.read.mockImplementation(async () => {
      order.push('b')
      return { bytes: new Uint8Array([3]), version: 'v1' }
    })
    const backgroundA = h.queue.read(a.request)
    const backgroundB = h.queue.read(b.request)
    const foreground = h.queue.read({ ...b.request, priority: 'foreground' })
    expect(a.read).not.toHaveBeenCalled()
    expect(b.read).not.toHaveBeenCalled()
    complete.resolve(OUTPUT)
    await Promise.all([first, backgroundA, backgroundB, foreground])
    // 被前台点名的那一份先跑
    expect(order).toEqual(['b', 'a'])
    expect(b.read).toHaveBeenCalledOnce()
  })

  it('队满时前台挤掉排队中的预热，后台溢出直接 busy', async () => {
    const h = queueHarness({ maxConcurrentConversions: 1, maxQueuedJobs: 1 })
    const entered = deferred<undefined>()
    const complete = deferred<typeof OUTPUT>()
    h.convert.mockImplementationOnce(() => {
      entered.resolve(undefined)
      return complete.promise
    })
    const first = h.queue.read(queueSource('active').request)
    await entered.promise
    const prewarm = queueSource('prewarm', 2, 'background')
    const discarded = expect(h.queue.read(prewarm.request)).rejects.toMatchObject({ code: 'busy' })
    await expect(
      h.queue.read(queueSource('overflow', 4, 'background').request)
    ).rejects.toMatchObject({
      code: 'busy'
    })
    const requested = queueSource('requested', 3)
    const next = h.queue.read(requested.request)
    await expect(h.queue.read(queueSource('overflow-2', 4).request)).rejects.toMatchObject({
      code: 'busy'
    })
    await discarded
    expect(prewarm.read).not.toHaveBeenCalled()
    expect(requested.read).not.toHaveBeenCalled()
    complete.resolve(OUTPUT)
    await Promise.all([first, next])
    expect(requested.read).toHaveBeenCalledOnce()
  })

  it('关掉预热时后台在读书之前就被拒，前台照跑', async () => {
    const h = queueHarness({ maxBackgroundConversions: 0 })
    const a = queueSource('a', 1, 'background')
    await expect(h.queue.read(a.request)).rejects.toMatchObject({ code: 'busy' })
    expect(a.read).not.toHaveBeenCalled()
    expect(h.convert).not.toHaveBeenCalled()
    await h.queue.read({ ...a.request, priority: 'foreground' })
    expect(a.read).toHaveBeenCalledOnce()
  })

  it('读者上限：最后一位留给前台，后台占不到', async () => {
    const h = queueHarness({ maxReaders: 2 })
    const entered = deferred<undefined>()
    const complete = deferred<typeof OUTPUT>()
    h.convert.mockImplementationOnce(() => {
      entered.resolve(undefined)
      return complete.promise
    })
    const a = queueSource('a', 1, 'background')
    const background = h.queue.read(a.request)
    await entered.promise
    await expect(h.queue.read(a.request)).rejects.toMatchObject({ code: 'busy' })
    const foreground = h.queue.read({ ...a.request, priority: 'foreground' })
    complete.resolve(OUTPUT)
    await Promise.all([background, foreground])
    expect(a.read).toHaveBeenCalledOnce()
  })

  it('共享同一次转换的读者：一个取消不会打断另一个，也不会取消引擎', async () => {
    const h = queueHarness({ maxReaders: 2 })
    const entered = deferred<AbortSignal>()
    const complete = deferred<typeof OUTPUT>()
    h.convert.mockImplementationOnce((_bytes, _extension, signal) => {
      entered.resolve(signal)
      return complete.promise
    })
    const a = queueSource('a')
    const caller = new AbortController()
    const first = expect(h.queue.read(a.request, caller.signal)).rejects.toMatchObject({
      name: 'AbortError'
    })
    const signal = await entered.promise
    const second = h.queue.read(a.request)
    await expect(h.queue.read(a.request)).rejects.toMatchObject({ code: 'busy' })
    caller.abort()
    await first
    expect(signal.aborted).toBe(false)
    complete.resolve(OUTPUT)
    await second
  })

  it('摘要共享的读者：原读者走了，另一个仍活着，引擎不被取消', async () => {
    const h = queueHarness()
    const entered = deferred<AbortSignal>()
    const complete = deferred<typeof OUTPUT>()
    h.convert.mockImplementationOnce((_bytes, _extension, signal) => {
      entered.resolve(signal)
      return complete.promise
    })
    const a = queueSource('a')
    const b = queueSource('b')
    const caller = new AbortController()
    const first = expect(h.queue.read(a.request, caller.signal)).rejects.toMatchObject({
      name: 'AbortError'
    })
    const signal = await entered.promise
    const second = h.queue.read(b.request)
    await vi.waitFor(() => expect(b.read).toHaveBeenCalledOnce())
    caller.abort()
    await first
    expect(signal.aborted).toBe(false)
    complete.resolve(OUTPUT)
    await second
    expect(h.convert).toHaveBeenCalledOnce()
  })

  it('源版本变了 / 读超预留容量：拒，且不转、不缓存', async () => {
    const h = queueHarness({ maxInputBytes: 2, maxSourceBytes: 2 })
    const a = queueSource('a')
    a.read.mockResolvedValueOnce({ bytes: new Uint8Array([1]), version: 'v2' })
    await expect(h.queue.read(a.request)).rejects.toMatchObject({ code: 'source-changed' })
    a.read.mockResolvedValueOnce({ bytes: new Uint8Array([1, 2]), version: 'v1' })
    await expect(h.queue.read(a.request)).rejects.toMatchObject({ code: 'input-too-large' })
    expect(h.convert).not.toHaveBeenCalled()
    await h.queue.read(a.request)
    expect(a.read).toHaveBeenCalledTimes(3)
    expect(a.read.mock.calls[0][1]).toBe(1)
  })

  it('未知 stat 大小按 maxInputBytes 预留；已知超限在读书之前就拒', async () => {
    const h = queueHarness({ maxInputBytes: 2, maxSourceBytes: 2 })
    const a = queueSource('a')
    await expect(
      h.queue.read({ ...a.request, source: { ...a.request.source, bytes: 3 } })
    ).rejects.toMatchObject({ code: 'input-too-large' })
    expect(a.read).not.toHaveBeenCalled()
    // 不带 bytes（未知 stat 大小）：按 maxInputBytes 预留
    const unknown: OfficePreviewRequest['source'] = {
      key: a.request.source.key,
      version: a.request.source.version,
      read: a.request.source.read
    }
    await h.queue.read({ ...a.request, source: unknown })
    expect(a.read.mock.calls[0][1]).toBe(2)
  })

  it('LRU 淘汰内容缓存，别名表另有独立上限', async () => {
    const h = queueHarness({ maxCachedEntries: 2, maxCachedBytes: 8, maxSourceEntries: 1 })
    const a = queueSource('a', 1)
    const alias = queueSource('alias', 1)
    const b = queueSource('b', 2)
    const c = queueSource('c', 3)
    await h.queue.read(a.request)
    await h.queue.read(alias.request)
    await h.queue.read(a.request)
    // 别名已被挤掉 → 再读 a 要重读一次字节（但内容还在缓存里，不再转）
    expect(a.read).toHaveBeenCalledTimes(2)
    expect(h.convert).toHaveBeenCalledOnce()
    await h.queue.read(b.request)
    await h.queue.read(a.request)
    await h.queue.read(c.request)
    await h.queue.read(b.request)
    expect(h.convert).toHaveBeenCalledTimes(4)
  })

  it('失败与超预算的 PDF 都不留在缓存里', async () => {
    const h = queueHarness({ maxCachedBytes: 1 })
    const a = queueSource('a')
    h.convert.mockRejectedValueOnce(new Error('engine failure'))
    await expect(h.queue.read(a.request)).rejects.toThrow('engine failure')
    await h.queue.read(a.request)
    await h.queue.read(a.request)
    expect(h.convert).toHaveBeenCalledTimes(3)
  })

  it('内容标识含扩展名与代次：换格式、换服务代次都是另一次转换', async () => {
    const h = queueHarness()
    const a = queueSource('a')
    const first = await h.queue.read(a.request)
    const otherFormat = await h.queue.read({ ...a.request, extension: 'pptx' })
    const replacement = new OfficePreviewQueue(config(), 'replacement-generation', h.convert)
    queues.push(replacement)
    const replaced = await replacement.read(a.request)
    expect(first.cacheKey).not.toBe(otherFormat.cacheKey)
    expect(first.cacheKey).not.toBe(replaced.cacheKey)
    expect(first.generation).toBe('test-generation')
  })

  it('读者位占满时，已就绪的 PDF 照样回（命中缓存不吃读者位）', async () => {
    const h = queueHarness({ maxReaders: 1 })
    const cached = queueSource('cached')
    await h.queue.read(cached.request)
    const entered = deferred<undefined>()
    const complete = deferred<typeof OUTPUT>()
    h.convert.mockImplementationOnce(() => {
      entered.resolve(undefined)
      return complete.promise
    })
    const pending = h.queue.read(queueSource('active', 2).request)
    try {
      await entered.promise
      await expect(h.queue.read(cached.request)).resolves.toMatchObject(OUTPUT)
      expect(cached.read).toHaveBeenCalledOnce()
      expect(h.convert).toHaveBeenCalledTimes(2)
    } finally {
      complete.resolve(OUTPUT)
      await pending
    }
  })

  it('取消后重建的作业不被旧作业的迟到收尾污染', async () => {
    const h = queueHarness({ maxConcurrentConversions: 2 })
    const firstEntered = deferred<undefined>()
    const firstComplete = deferred<typeof OUTPUT>()
    const replacementEntered = deferred<undefined>()
    const replacementComplete = deferred<typeof OUTPUT>()
    const replacementSpawned = deferred<{ work: Promise<OfficePreviewConversion> }>()
    const a = queueSource('a')
    const caller = new AbortController()
    const pending: Promise<unknown>[] = []
    h.convert
      .mockImplementationOnce((_bytes, _extension, signal) => {
        signal.addEventListener(
          'abort',
          () => {
            const work = h.queue.read(a.request)
            pending.push(work)
            replacementSpawned.resolve({ work })
          },
          { once: true }
        )
        firstEntered.resolve(undefined)
        return firstComplete.promise
      })
      .mockImplementationOnce(() => {
        replacementEntered.resolve(undefined)
        return replacementComplete.promise
      })
    const first = expect(h.queue.read(a.request, caller.signal)).rejects.toMatchObject({
      cause: 'reader left'
    })
    pending.push(first)
    try {
      await firstEntered.promise
      caller.abort('reader left')
      await first
      const { work: replacement } = await replacementSpawned.promise
      await replacementEntered.promise
      const next = h.queue.read(queueSource('next', 2).request)
      pending.push(next)
      firstComplete.resolve(OUTPUT)
      await next
      const sameSource = h.queue.read(a.request)
      const alias = queueSource('alias', 1, 'background')
      const sameContent = h.queue.read(alias.request)
      pending.push(sameSource, sameContent)
      await vi.waitFor(() => expect(alias.read).toHaveBeenCalledOnce())
      expect(a.read).toHaveBeenCalledTimes(2)
      expect(h.convert).toHaveBeenCalledTimes(3)
      replacementComplete.resolve(OUTPUT)
      const results = await Promise.all([replacement, sameSource, sameContent])
      expect(new Set(results.map((result) => result.cacheKey)).size).toBe(1)
    } finally {
      firstComplete.resolve(OUTPUT)
      replacementComplete.resolve(OUTPUT)
      await Promise.allSettled(pending)
    }
  })

  it('dispose：在途读者与服务之后的调用都是 unavailable', async () => {
    const h = queueHarness()
    const entered = deferred<undefined>()
    const complete = deferred<typeof OUTPUT>()
    h.convert.mockImplementationOnce(() => {
      entered.resolve(undefined)
      return complete.promise
    })
    const pending = expect(h.queue.read(queueSource('active').request)).rejects.toMatchObject({
      code: 'unavailable'
    })
    await entered.promise
    const closing = h.queue.dispose()
    try {
      await pending
      await expect(h.queue.read(queueSource('later').request)).rejects.toMatchObject({
        code: 'unavailable'
      })
    } finally {
      complete.resolve(OUTPUT)
      await closing
    }
  })
})

/* ── 产出校验 ─────────────────────────────────────────────────────────── */

describe('readPreviewPdf', () => {
  async function pdfFile(content: Buffer | string, name = 'preview.pdf'): Promise<string> {
    const directory = await tempDir()
    const path = join(directory, name)
    await writeFile(path, content)
    return path
  }

  it('读到完整 PDF 就回字节', async () => {
    const path = await pdfFile(PDF)
    const signal = new AbortController().signal
    // 逐字节比（返回的是 Buffer 视图，`toEqual` 会拿构造器比、Buffer ≠ Uint8Array）
    expect(Buffer.from(await readPreviewPdf(path, PDF.length, signal))).toEqual(PDF)
  })

  it.each([
    ['不存在', 'missing'],
    ['不是 PDF', 'not-pdf'],
    ['截断', 'incomplete']
  ] as const)('产出%s：invalid-output', async (_label, shape) => {
    const signal = new AbortController().signal
    if (shape === 'missing') {
      const directory = await tempDir()
      await expect(readPreviewPdf(join(directory, 'nope.pdf'), 1024, signal)).rejects.toMatchObject(
        { code: 'invalid-output' }
      )
      return
    }
    const path = await pdfFile(shape === 'not-pdf' ? 'engine diagnostic' : '%PDF-1.7\n')
    await expect(readPreviewPdf(path, 1024, signal)).rejects.toMatchObject({
      code: 'invalid-output'
    })
  })

  it('目录：invalid-output（不当常规文件读）', async () => {
    const directory = await tempDir()
    await expect(
      readPreviewPdf(directory, 1024, new AbortController().signal)
    ).rejects.toMatchObject({ code: 'invalid-output' })
  })

  it('超过上限：output-too-large', async () => {
    const path = await pdfFile(PDF)
    await expect(
      readPreviewPdf(path, PDF.length - 1, new AbortController().signal)
    ).rejects.toMatchObject({ code: 'output-too-large' })
  })

  it('已中止：按中止原因拒（不去读盘）', async () => {
    const path = await pdfFile(PDF)
    const controller = new AbortController()
    const reason = new Error('用户点了停止')
    controller.abort(reason)
    await expect(readPreviewPdf(path, 1024, controller.signal)).rejects.toBe(reason)
  })
})

/* ── 引擎适配（注入 runner，不起进程） ──────────────────────────────────── */

/** 一次"服务 + 假引擎"的现场：跑过的 spec 与自建过的临时目录都在手上 */
function engineHarness(
  partial: Partial<OfficePreviewConfig> = {},
  options: {
    pdf?: Uint8Array | null
    result?: Partial<OfficePreviewRunResult>
    onRun?: (spec: OfficePreviewRunSpec) => Promise<void> | void
    kitCli?: string | null
  } = {}
): {
  provider: OfficePreview
  runs: OfficePreviewRunSpec[]
  dirs: string[]
} {
  const runs: OfficePreviewRunSpec[] = []
  const dirs: string[] = []
  const provider = new OfficePreview(config(partial), {
    kitCli: options.kitCli === undefined ? CLI : options.kitCli,
    run: pdfRunner(runs, options),
    makeTempDir: async () => {
      const directory = await tempDir()
      dirs.push(directory)
      return directory
    }
  })
  providers.push(provider)
  return { provider, runs, dirs }
}

/** 建过的服务（用例结束统一 dispose） */
const providers: OfficePreview[] = []
afterEach(async () => {
  for (const provider of providers.splice(0)) await provider.dispose()
})

function previewRequest(bytes: Uint8Array = INPUT, version = 'v1'): OfficePreviewRequest {
  return {
    extension: 'docx',
    priority: 'foreground',
    source: {
      key: officePreviewSourceKey('thread-1', 'C:/work/docs/a.docx'),
      version,
      bytes: bytes.byteLength,
      read: async () => ({ bytes, version })
    }
  }
}

describe('引擎适配', () => {
  it('把源字节写进自建临时目录，按固定开关跑 kit 的 CLI，回 PDF 与缺字体', async () => {
    const seen: { input: string; output: string; copy: Buffer }[] = []
    const h = engineHarness(
      {
        timeoutMs: 321,
        maxInputBytes: 1234,
        maxOutputBytes: 4096,
        maxImageResolution: 96,
        fontDirectories: [FONT_DIR],
        fontFallbacks: [['sans-serif', 'Arial']]
      },
      {
        onRun: async (spec) => {
          const input = flagValue(spec.args, '--input') ?? ''
          const output = flagValue(spec.args, '--output') ?? ''
          seen.push({ input, output, copy: await readFile(input) })
        }
      }
    )
    const result = await h.provider.convert(previewRequest())

    expect(result.pdf).toEqual(Uint8Array.from(PDF))
    expect(result.missingFonts).toEqual(['缺失的字体'])
    expect(result.cacheKey).toContain(h.provider.getGeneration())
    expect(h.runs).toHaveLength(1)

    const spec = h.runs[0]
    expect(spec.command).toBe(process.execPath)
    expect(spec.env?.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(spec.args[0]).toBe(CLI)
    expect(spec.args[1]).toBe('convert')
    expect(spec.timeoutMs).toBe(321 + OFFICE_PREVIEW_RUN_GRACE_MS)
    expect(flagValue(spec.args, '--timeout-ms')).toBe('321')
    expect(flagValue(spec.args, '--max-input-bytes')).toBe('1234')
    expect(flagValue(spec.args, '--max-output-bytes')).toBe('4096')
    expect(flagValue(spec.args, '--max-image-resolution')).toBe('96')
    expect(flagValue(spec.args, '--font-directory')).toBe(FONT_DIR)
    // 字体优先组是**一个** JSON 参数（整份组数组），不是可重复的开关
    expect(flagValue(spec.args, '--font-fallbacks')).toBe('[["sans-serif","Arial"]]')
    expect(spec.args.filter((arg) => arg === '--font-fallbacks')).toHaveLength(1)

    const run = seen[0]
    expect(spec.cwd).toBe(h.dirs[0])
    expect(run.input).toBe(join(h.dirs[0], 'source.docx'))
    expect(run.output).toBe(join(h.dirs[0], 'preview.pdf'))
    expect(run.copy).toEqual(Buffer.from(INPUT))
    // 收尾只删自建目录
    await expect(access(h.dirs[0])).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('二进制源的缺字体名单为空（引擎不声明 = 查不了，不编）', async () => {
    const h = engineHarness({}, { result: { text: '{"backend":"native","outputPath":"x"}\n' } })
    const request = { ...previewRequest(), extension: 'ppt' as const }
    const result = await h.provider.convert(request)
    expect(result.missingFonts).toEqual([])
  })

  it('跑完却没有产出：invalid-output，且临时目录照样清掉', async () => {
    const h = engineHarness({}, { pdf: null })
    await expect(h.provider.convert(previewRequest())).rejects.toMatchObject({
      code: 'invalid-output'
    })
    await expect(access(h.dirs[0])).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('产出不是 PDF：invalid-output', async () => {
    const h = engineHarness({}, { pdf: Buffer.from('engine diagnostic') })
    await expect(h.provider.convert(previewRequest())).rejects.toMatchObject({
      code: 'invalid-output'
    })
  })

  it('产出超上限：output-too-large', async () => {
    const h = engineHarness({ maxOutputBytes: PDF.length - 1 })
    await expect(h.provider.convert(previewRequest())).rejects.toMatchObject({
      code: 'output-too-large'
    })
  })

  it('起不了引擎：unavailable（带上引擎路径）', async () => {
    const h = engineHarness({}, { result: { spawnError: new Error('ENOENT'), text: '' } })
    await expect(h.provider.convert(previewRequest())).rejects.toMatchObject({
      code: 'unavailable'
    })
  })

  it('没有随包引擎：unavailable，且不建临时目录、不起进程', async () => {
    const h = engineHarness({}, { kitCli: null })
    await expect(h.provider.convert(previewRequest())).rejects.toMatchObject({
      code: 'unavailable'
    })
    expect(h.runs).toHaveLength(0)
    expect(h.dirs).toHaveLength(0)
  })

  it('引擎超时：timeout（与失败分开报）', async () => {
    const h = engineHarness({}, { result: { timedOut: true, exitCode: null, text: '' } })
    await expect(h.provider.convert(previewRequest())).rejects.toMatchObject({ code: 'timeout' })
  })

  it.each([
    ['input-too-large'],
    ['output-too-large'],
    ['invalid-document'],
    ['unsupported-format'],
    ['invalid-output'],
    ['timeout'],
    ['unavailable']
  ] as const)('引擎报的 %s 原样透传（分类不丢）', async (code) => {
    const h = engineHarness(
      {},
      { result: { exitCode: 1, text: `${JSON.stringify({ code, error: 'engine says' })}\n` } }
    )
    await expect(h.provider.convert(previewRequest())).rejects.toMatchObject({ code })
  })

  it('引擎报了认不出的分类或干脆没报：failed（不硬猜）', async () => {
    const unknown = engineHarness(
      {},
      { result: { exitCode: 1, text: '{"code":"who-knows","error":"boom"}\n' } }
    )
    await expect(unknown.provider.convert(previewRequest())).rejects.toMatchObject({
      code: 'failed'
    })
    const silent = engineHarness({}, { result: { exitCode: 1, text: 'something broke\n' } })
    await expect(silent.provider.convert(previewRequest())).rejects.toMatchObject({
      code: 'failed'
    })
  })

  it('用户中止：按中止原因拒、清掉临时目录（不伪装成"转不了"）', async () => {
    const controller = new AbortController()
    const reason = new Error('用户点了停止')
    const h = engineHarness(
      {},
      {
        pdf: null,
        result: { aborted: true, exitCode: null, text: '' },
        onRun: () => {
          controller.abort(reason)
        }
      }
    )
    await expect(h.provider.convert(previewRequest(), controller.signal)).rejects.toBe(reason)
    // 调用方的拒绝是**立刻**的（队列的 abort 处理器当场拒）；引擎那一步的收尾（删自建临时目录）稍后落地 ——
    // 所以这里等它收完再断言"不留残余"，而不是假设它已经删完
    await vi.waitFor(async () => {
      await expect(access(h.dirs[0])).rejects.toMatchObject({ code: 'ENOENT' })
    })
  })

  it('准入之前就中止：一个副作用都不留（不建目录、不起进程）', async () => {
    const h = engineHarness()
    const reason = new Error('用户点了停止')
    await expect(h.provider.convert(previewRequest(), AbortSignal.abort(reason))).rejects.toBe(
      reason
    )
    expect(h.runs).toHaveLength(0)
    expect(h.dirs).toHaveLength(0)
  })

  it('探测失败过一次仍会重试（不把服务钉死在不可用）', async () => {
    const runs: OfficePreviewRunSpec[] = []
    const provider = new OfficePreview(config(), {
      run: pdfRunner(runs),
      makeTempDir: trackingTempDir()
    })
    providers.push(provider)
    kit.resolve.mockReturnValueOnce(null)
    await expect(provider.convert(previewRequest())).rejects.toMatchObject({ code: 'unavailable' })
    kit.resolve.mockReturnValueOnce(CLI)
    await expect(provider.convert(previewRequest())).resolves.toMatchObject({
      missingFonts: ['缺失的字体']
    })
    expect(runs).toHaveLength(1)
  })
})

/* ── 服务面 ───────────────────────────────────────────────────────────── */

describe('OfficePreview', () => {
  it('不认识的扩展名：unsupported-format，不起进程', async () => {
    const h = engineHarness()
    const request = { ...previewRequest(), extension: 'xlsx' as unknown as 'docx' }
    await expect(h.provider.convert(request)).rejects.toMatchObject({
      code: 'unsupported-format'
    })
    expect(h.runs).toHaveLength(0)
  })

  it('源超上限在起进程之前就拒', async () => {
    const h = engineHarness({ maxInputBytes: 3 })
    await expect(
      h.provider.convert(previewRequest(Uint8Array.from([1, 2, 3, 4])))
    ).rejects.toMatchObject({ code: 'input-too-large' })
    expect(h.runs).toHaveLength(0)
  })

  it('没有 read 回调：直接拒（不当成"没有源"放过）', async () => {
    const h = engineHarness()
    const request = {
      ...previewRequest(),
      source: { key: 'k', version: 'v1' } as unknown as OfficePreviewRequest['source']
    }
    await expect(h.provider.convert(request)).rejects.toThrow(/read\(signal, maxBytes\)/)
  })

  it('同一份文件连点两次：只转一次', async () => {
    const h = engineHarness()
    const [first, second] = await Promise.all([
      h.provider.convert(previewRequest()),
      h.provider.convert(previewRequest())
    ])
    expect(h.runs).toHaveLength(1)
    expect(first.cacheKey).toBe(second.cacheKey)
  })

  it('换了版本会重读源，但字节一样就复用转好的 PDF（内容寻址，不是按版本缓存）', async () => {
    const h = engineHarness()
    const request = previewRequest()
    const first = await h.provider.convert(request)
    let reads = 0
    const changed: OfficePreviewRequest = {
      ...request,
      source: {
        ...request.source,
        version: 'v2',
        read: async () => {
          reads += 1
          return { bytes: INPUT, version: 'v2' }
        }
      }
    }
    const second = await h.provider.convert(changed)
    // 别名表按 (定位, 版本, 扩展名) 判，所以新版本一定真读一次源（不拿旧版本的字节充数）
    expect(reads).toBe(1)
    expect(second.cacheKey).toBe(first.cacheKey)
    expect(h.runs).toHaveLength(1)
  })

  it('字节变了就是另一次转换', async () => {
    const h = engineHarness()
    const request = previewRequest()
    await h.provider.convert(request)
    const changed: OfficePreviewRequest = {
      ...request,
      source: {
        ...request.source,
        version: 'v2',
        // 同长度、不同内容（长度也变的话会先撞上"超预留"那条，测不到"内容变了要重转"）
        read: async () => ({ bytes: Uint8Array.from([...INPUT.slice(0, -1), 0x33]), version: 'v2' })
      }
    }
    await expect(h.provider.convert(changed)).resolves.toBeDefined()
    expect(h.runs).toHaveLength(2)
  })

  it('dispose 之后一律 unavailable', async () => {
    const h = engineHarness()
    await h.provider.dispose()
    await expect(h.provider.convert(previewRequest())).rejects.toMatchObject({
      code: 'unavailable'
    })
  })

  it('配置有问题在构造时就抛（不等到第一次转换）', () => {
    expect(() => new OfficePreview({ fontDirectories: ['relative/fonts'] })).toThrow(
      'fontDirectories 必须是绝对路径'
    )
    expect(() => new OfficePreview({ fontFallbacks: [['sans-serif']] })).toThrow(
      'fontFallbacks 的每一组至少要两个非空白字体名'
    )
    expect(() => new OfficePreview({ maxInputBytes: 4, maxSourceBytes: 3 })).toThrow(
      'maxSourceBytes 不能小于 maxInputBytes'
    )
    expect(() => new OfficePreview({ maxCachedEntries: 0 })).toThrow('maxCachedEntries')
  })

  it('代次与源定位键/版本都是稳定且不可解析的值', () => {
    const provider = createOfficePreview()
    expect(provider.getGeneration()).toBe(provider.getGeneration())
    expect(provider.getGeneration()).not.toBe(createOfficePreview().getGeneration())
    // 拼串会让 ('a','bc') 与 ('ab','c') 撞成同一个键
    expect(officePreviewSourceKey('a', 'bc')).not.toBe(officePreviewSourceKey('ab', 'c'))
    expect(officePreviewSourceVersion({ size: 12, mtimeMs: 34 })).toBe('12:34')
  })

  it('自建的临时目录带固定前缀，收尾只删自建的那个目录', async () => {
    const runs: OfficePreviewRunSpec[] = []
    // 这条刻意不注入 makeTempDir：走服务自己那条真 mkdtemp / 真 rm
    const provider = new OfficePreview(config(), { kitCli: CLI, run: pdfRunner(runs) })
    providers.push(provider)
    await provider.convert(previewRequest())
    const output = flagValue(runs[0].args, '--output') ?? ''
    expect(output).toContain(OFFICE_PREVIEW_TEMP_PREFIX)
    await expect(access(dirname(output))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
