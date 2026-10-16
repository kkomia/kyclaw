/**
 * 办公档页式预览的**转换口**（渲染端这一侧）：把组件的 `AbortSignal` 翻译成真正的
 * `cancelOfficePdf(requestId)` IPC —— 取消不是"不再看回包"，是真的让主进程把那一趟引擎停掉。
 *
 * 合同来源（**只读不改**）：`src/shared/office-preview.ts`（通道 / 结果 / 失败分类 / requestId
 * 形状）与 `src/shared/ipc.ts` 的 `KyclawWorkbenchApi.officePdf` / `cancelOfficePdf`。
 *
 * 三条口径照合同走，别自己发明：
 *   1) `requestId` **每次发起一个新值**（`crypto.randomUUID()`），只服务"取消"这一件事；
 *      同一个窗口拿同一个 id 再发一次 = 新请求顶掉旧的（旧的那次回 `cancelled`）；
 *   2) **取消也是一种"回来了"**：`cancelOfficePdf` 之后原来那一趟照常 resolve
 *      `{ kind: 'failed', code: 'cancelled' }`，**不是 reject** —— 但界面口径是"直接丢弃、不报错"，
 *      所以这里把它翻成 `AbortError`（组件的 `isAbortError` 收口就在那儿）；
 *   3) `missingFonts` 只有 docx / pptx 才有内容；doc / ppt 回空数组是"查不了"而不是"不缺字"，
 *      界面**只在名单非空时**提示（组件已经这么做了），不反过来说"字体齐全"。
 */
import type { KyclawWorkbenchApi } from '@shared/ipc'
import type { OfficePreviewErrorCode, OfficePreviewPriority } from '@shared/office-preview'
import type { DshOfficeLoad, DshOfficeLoadResult } from './office'

/** 转换真正用到的那两个方法（其余一概不碰：单测喂一个小对象就够，不必造整份 KyclawWorkbenchApi）。 */
export type OfficeBridge = Pick<KyclawWorkbenchApi, 'officePdf' | 'cancelOfficePdf'>

/** 一次页式预览的转换口 + 它的代次（宿主每重读一次就换一个号，阅读器据此重新转）。 */
export interface OfficeLoadHandle {
  readonly load: DshOfficeLoad
  /** 单调递增的读取代次：同一份预览状态里它不变，重读一次就换一个。 */
  readonly revision: number
}

/** 转换失败（带上主进程给的分类）：界面据此决定"要不要重试 / 刷新"。 */
export class OfficePreviewFailure extends Error {
  readonly code: OfficePreviewErrorCode

  constructor(code: OfficePreviewErrorCode, message: string) {
    super(message)
    this.name = 'OfficePreviewFailure'
    this.code = code
  }
}

/** 取消用的理由（与 `AbortSignal` 自己那个同形：`name === 'AbortError'`，不继承 Error）。 */
function cancelled(message: string): DOMException {
  return new DOMException(message, 'AbortError')
}

/** 每次读取一个新代次（模块级计数：跨文件/跨重读都不会撞）。 */
let revisionCounter = 0

/**
 * 造一个转换口。
 * @param workbench 工作台桥（只用到 `officePdf` / `cancelOfficePdf`）。
 * @param threadId 会话 id（授权在主进程：这里只递"树上哪一条"）。
 * @param relative 相对会话根的路径。
 * @param priority 调度意图（当前接线只用 foreground）。
 * @returns 转换口与本次读取的代次。
 */
export function officeLoadFor(
  workbench: OfficeBridge,
  threadId: string,
  relative: string,
  priority: OfficePreviewPriority = 'foreground'
): OfficeLoadHandle {
  revisionCounter += 1
  const revision = revisionCounter
  return {
    revision,
    load: async (signal: AbortSignal): Promise<DshOfficeLoadResult> => {
      const requestId = crypto.randomUUID()
      // 取消要真发 IPC；但它本身失败（通道断了 / preload 旧）不能把"取消"变成一次崩溃：
      // 取消是用户自己的动作，界面那边无论失败原因都按"不报错"收口。
      const cancel = (): void => {
        try {
          void workbench.cancelOfficePdf(requestId).catch(() => undefined)
        } catch {
          // 取消失败不改结论：这一趟要么已经被主进程停了，要么本来就结束了
        }
      }
      if (signal.aborted) {
        cancel()
        throw cancelled('办公档页式预览已取消')
      }
      signal.addEventListener('abort', cancel, { once: true })
      try {
        const result = await workbench.officePdf(threadId, relative, priority, requestId)
        signal.throwIfAborted()
        if (result.kind === 'failed') {
          // 取消走"不是错误"那条路（组件按 AbortError 识别）
          if (result.code === 'cancelled') throw cancelled(result.message)
          throw new OfficePreviewFailure(result.code, result.message)
        }
        return { bytes: result.pdf, missingFonts: result.missingFonts }
      } finally {
        signal.removeEventListener('abort', cancel)
      }
    }
  }
}

/**
 * 转换失败 → 人话（`message` 已经是主进程给的中文；这里只补"下一步该做什么"那一句）。
 * @param error 转换口抛出来的失败。
 */
export function describeOfficeFailure(error: unknown): string {
  const message =
    error instanceof Error && error.message !== '' ? error.message : '这份文档转不出预览'
  if (error instanceof OfficePreviewFailure) {
    if (error.code === 'busy') return `${message}（稍等一会儿再试一次）`
    if (error.code === 'source-changed' || error.code === 'missing') {
      return `${message}（刷新一下文件树再看）`
    }
  }
  return message
}
