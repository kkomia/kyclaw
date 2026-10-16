/**
 * HTML 静态预览（隔离 iframe，**不启用脚本模式**）。
 *
 * 适配自 deepseek-harness（MIT，commit 86a4022）的
 * `packages/client/ui-sidebar-documentpreview/src/client/html/HtmlBody.tsx` 的 **BasicHtmlFrame** 一路
 * （它还有一条 allow-scripts + 打包相对 .js/.css 的"交互预览"，本仓明确**不移植**：脚本模式需要
 * 另一套资源打包与依赖读写通道，不在本轮范围，见文件末"未做"）。
 *
 * 口径（与上游一致 + 本仓的取舍）：
 *   - **srcdoc + sandbox=""**：文档在独立浏览上下文里解析，`sandbox` 一个权限都不给
 *     （无脚本、无表单、无弹窗、无同源）——它拿不到应用 DOM，也拿不到 IPC/preload；
 *   - **不在应用 DOM 里渲染 HTML**：字节只进这个 iframe 的 srcdoc，不 `dangerouslySetInnerHTML`；
 *   - 文档正文先过 `createBasicHtmlDocument`：常见形态的资源属性与 CSS 外链在清洗阶段就被抹掉
 *     （**不宣称穷尽**，见 `html-document.ts` 文件头的边界）——CSP 与 sandbox 是**必须边界**而非补充；
 *   - 解码按 BOM 走（UTF-8 / 带 BOM 的 UTF-16LE·BE，与主进程 `sniffFormat` 同一组）；读不出来给人话。
 *
 * 未做（如实登记）：脚本模式的交互预览、把相对 .js/.css 打进来、`<base href>` 解析 —— 都没做。
 */
import { useMemo } from 'react'
import { createBasicHtmlDocument } from './html-document'
import './dsh-media.css'

/**
 * 一份 HTML 的静态预览。
 * @param props `bytes` 是主进程读回的**完整** HTML 字节（身份变化即换文档）。
 * @returns 隔离的静态文档 frame；读不出来时给人话。
 */
export function DshHtmlViewer({ bytes }: { bytes: Uint8Array }): React.JSX.Element {
  const result = useMemo(() => {
    try {
      return { html: createBasicHtmlDocument(bytes) }
    } catch {
      // 解码（BOM 之外无效的字节序列、不带 BOM 的 UTF-16）或清洗失败 —— 到不了"能显示的文档"这一步
      return { html: null }
    }
  }, [bytes])

  if (result.html === null) {
    return (
      <p data-testid="dsh-html-error" className="dsh-media-status">
        这份 HTML 读不出来（不是 UTF-8，也不是带 BOM 的 UTF-16 文本）
      </p>
    )
  }

  return (
    <iframe
      data-testid="dsh-html-preview"
      className="dsh-html-frame"
      title="HTML 文档预览"
      sandbox=""
      allow=""
      referrerPolicy="no-referrer"
      srcDoc={result.html}
    />
  )
}
