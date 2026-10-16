/**
 * 纯文本文档体：按源码行铺开（每行一个块、行号口径留给后续"跳到某行"）。
 *
 * 上游对照：deepseek-harness（MIT，commit 86a4022）的
 * `packages/client/ui-sidebar-documentpreview/src/client/text/TextBody.tsx`：它把每一页按行铺成
 * `<div>`（每行一块、行号是数据属性），为的是"按行定位/跳到某行"那条能力。
 * 本组件只负责**把手上这一份文本按行铺开**（页的取数、累加与"加载更多"在 `paged-text.tsx`）：
 *   - 每行一个块 + 显式换行符 —— 框选复制出来的仍是**原文**（不多不少，一个换行符都对得上）；
 *   - 等宽字体与行高与代码块同档（上游口径：纯文本与代码同字号同行高）；
 *   - 自动换行缺省**开**（保持本仓既有观感：原来就是 `pre-wrap break-all`）；
 *   - 不做行号（上游纯文本也没有行号），不做截断提示（那是调用方的事）。
 */
import { useMemo } from 'react'
import './dsh-media.css'

/**
 * 一段纯文本。
 * @param props `text` 是全文（文本通道的有界内容）。
 * @returns 逐行铺开的等宽文本体。
 */
export function DshTextBody({ text }: { text: string }): React.JSX.Element {
  const lines = useMemo(() => {
    // 末尾换行不额外摊出一整行空行；每行自己补回 '\n'，复制结果与原文逐字节相同
    const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text
    return trimmed === '' ? [''] : trimmed.split('\n')
  }, [text])

  return (
    <div className="dsh-media-text" data-testid="dsh-text-body">
      <pre className="dsh-media-text-page">
        {lines.map((line, index) => (
          <div key={index} className="dsh-media-text-line" data-dsh-text-line={index + 1}>
            {line}
            {'\n'}
          </div>
        ))}
      </pre>
    </div>
  )
}
