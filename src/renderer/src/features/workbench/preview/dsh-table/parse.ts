/**
 * 主线程这一侧：把字节丢进一次性 Worker 解，**严格隔离**——起不来 Worker 就不解析。
 *
 * 移植自 DeepSeek Harness（MIT）`packages/client/ui-sidebar-documentpreview/src/client/excel/parse.ts`；
 * 出处与许可见同目录 `NOTICE.md`。
 *
 * 与上游的差异（三处）：
 *   1. **Worker 的来源**：上游把 `worker.ts?raw` 塞进 Blob 再 `new Worker(blobURL)`；本仓库渲染端
 *      CSP 是 `default-src 'self'`（没有 `worker-src blob:`），Blob Worker 会被拒。这里走 Vite 的
 *      worker 打包（`new Worker(new URL('./excel.worker.ts', import.meta.url), …)`），产物是同源
 *      脚本文件，`'self'` 放行。
 *   2. **没有同线程兜底**：Worker 起不来 / 加载失败 / 收发失败一律回一类**可重试**的失败
 *      （`ExcelPreviewError('worker')`，界面摆重试按钮）。不把不可信的大文件放到主线程解——
 *      那样既会阻塞 UI，到点也只能拒掉 Promise、**真掐不断**已经在跑的解析。
 *   3. **每份字节都是拷贝**：同一份数组会被重复解析（React 严格模式两次 effect、组件重挂），
 *      把调用方的 buffer 转移给 Worker 会让下一次拿到空数组。
 *
 * 释放口径：无论成功 / 失败 / 超时 / abort，`finish()` 都会摘掉全部回调并 `terminate()` ——
 * 中断时 Worker 立刻结束，不留残余计算与监听。
 */
import { ExcelPreviewError, type ExcelPreviewErrorCode } from './errors'
import type { ExcelFormat } from './format'
import type { ExcelLimits, ExcelPreview } from './model'
import { isParserErrorCode, validPreview, type ParserRequest } from './worker-protocol'

/**
 * 解一份表格字节（Worker 里解；环境没有 Worker 时**明确失败**，不降级）。
 *
 * `async` 是刻意的：已经 abort 的信号要回一条**拒掉的 Promise**，不能同步抛出来
 * （调用方一律按 Promise 处理；同步抛会穿过 `void x.then(…)` 变成 effect 里的未捕获错误）。
 * @param bytes 完整文件字节（**只读借用**：交给 Worker 前会拷一份自己的）
 * @param format 按后缀定下来的格式
 * @param limits 文件 / 矩阵 / 超时上限
 * @param signal 归调用方所有：abort 后立刻拒掉，且不再回填结果（Worker 同时被终止）
 * @returns 解析结果
 */
export async function parseExcel(
  bytes: Uint8Array,
  format: ExcelFormat,
  limits: ExcelLimits,
  signal: AbortSignal
): Promise<ExcelPreview> {
  signal.throwIfAborted()
  if (bytes.byteLength > limits.maxBytes) {
    throw new ExcelPreviewError('tooLarge')
  }
  const worker = spawnParserWorker()
  if (worker === null) throw new ExcelPreviewError('worker')
  return await parseInWorker(worker, bytes, format, limits, signal)
}

/** 起一个一次性解析 Worker；环境里没有 Worker（jsdom 等）或它起不来时回 null */
function spawnParserWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null
  try {
    return new Worker(new URL('./excel.worker.ts', import.meta.url), {
      type: 'module',
      name: 'kyclaw-table'
    })
  } catch {
    return null
  }
}

/** 拷一份**自己拥有**的字节（随消息转移时不动调用方的数组） */
function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy
}

function parseInWorker(
  worker: Worker,
  bytes: Uint8Array,
  format: ExcelFormat,
  limits: ExcelLimits,
  signal: AbortSignal
): Promise<ExcelPreview> {
  return new Promise<ExcelPreview>((resolve, reject) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      worker.onmessage = null
      worker.onerror = null
      worker.onmessageerror = null
      worker.terminate()
    }
    const onAbort = (): void => {
      finish()
      reject(new DOMException('Excel preview closed', 'AbortError'))
    }
    /** Worker 这条腿没能用起来（起不来 / 加载失败 / 收发失败）：给可重试的失败，不降级到主线程 */
    const failWorker = (options?: ErrorOptions): void => {
      finish()
      reject(new ExcelPreviewError('worker', options))
    }
    const timer = setTimeout(() => {
      finish()
      reject(new ExcelPreviewError('timeout'))
    }, limits.timeoutMs)
    worker.onerror = () => {
      failWorker()
    }
    worker.onmessageerror = () => {
      failWorker()
    }
    worker.onmessage = (event: MessageEvent<unknown>) => {
      const message = event.data
      if (typeof message !== 'object' || message === null || !('ok' in message)) {
        finish()
        reject(new ExcelPreviewError('invalid'))
        return
      }
      const response = message as {
        ok: unknown
        value?: unknown
        code?: unknown
      }
      if (response.ok === true && validPreview(response.value)) {
        finish()
        resolve(response.value)
        return
      }
      if (response.ok === false && isParserErrorCode(response.code)) {
        const code: ExcelPreviewErrorCode = response.code
        finish()
        reject(new ExcelPreviewError(code))
        return
      }
      finish()
      reject(new ExcelPreviewError('invalid'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) {
      onAbort()
      return
    }
    try {
      const copy = copyBytes(bytes)
      const request: ParserRequest = { bytes: copy, format, limits }
      worker.postMessage(request, [copy.buffer])
    } catch (error) {
      failWorker({ cause: error })
    }
  })
}
