/**
 * 解析 Worker 的入口：**一个工作簿一个一次性 Worker**，公式与外链一律不执行。
 *
 * 移植自 DeepSeek Harness（MIT）`packages/client/ui-sidebar-documentpreview/src/client/excel/worker.ts`；
 * 出处与许可见同目录 `NOTICE.md`。
 * 差异：上游把这份源码当 `?raw` 内联成 Blob Worker，这里由 Vite 打包成独立 Worker 文件
 * （`new Worker(new URL(…))`，见 `parse.ts`），所以收发口写成 `globalThis` + 一个最小接口。
 */
import { convertExcel } from './convert'
import { ExcelPreviewError } from './errors'
import type { ParserRequest, ParserResponse } from './worker-protocol'

/** DOM lib 里没有 worker 作用域类型；这里只要"收一条、发一条" */
interface WorkerScope {
  onmessage: ((event: MessageEvent<ParserRequest>) => void) | null
  postMessage: (message: ParserResponse) => void
}

const scope = globalThis as unknown as WorkerScope

scope.onmessage = (event) => {
  void convertExcel(event.data.bytes, event.data.format, event.data.limits).then(
    (value) => {
      scope.postMessage({ ok: true, value })
    },
    (error: unknown) => {
      scope.postMessage({
        ok: false,
        code: error instanceof ExcelPreviewError ? error.code : 'invalid'
      })
    }
  )
}
