import type { ReactNode } from 'react'
import { FileText } from 'lucide-react'
import { REFERENCE_ICONS, referenceLabel } from './reference-icons'
import type { ReferenceItem } from './reference-markers'

/**
 * 引用 chip（round 21，图3 样式）：细描边圆角 pill + **图标** + `kind：label`。
 *
 * 输入框的不透明覆盖层与发送后的气泡**共用这一份内容渲染**（图标 + 文本 [+ 尾随控件]），
 * 两处观感一致；外壳各自决定（气泡 = inline-flex 跟随正文流；覆盖层 = absolute 铺满
 * 隐形占位盒）。「【引用】」前缀只存在于原文里（模型/复制口径），**不进可见层**。
 * 底一律用**不透明**的 Bg 系 token（Fills 系是半透明填充，当"盖字形"的底会透出原文）。
 */
export function ReferenceChipInner({
  refs,
  trailing
}: {
  refs: readonly ReferenceItem[]
  trailing?: ReactNode
}): React.JSX.Element {
  const first = refs[0]
  const Icon = first === undefined ? FileText : REFERENCE_ICONS[first.kind]
  return (
    <>
      <Icon aria-hidden="true" className="size-3.5 shrink-0 text-ink-tertiary" />
      <span className="min-w-0 truncate">{referenceLabel(refs)}</span>
      {trailing}
    </>
  )
}

/**
 * 气泡里的引用 chip（发送后的消息；**无 ×**）：inline-flex 跟随正文流。
 * 外层气泡是 `whitespace-pre-wrap` 的普通文本流——chip 作为行内元素嵌在文字之间，
 * 不单独起一排（用户口径：要"融入到对话中"）。底用 **bg-surface（不透明）**：
 * 气泡本身是 bg-secondary，Fills 系是半透明填充（5% 黑）——当底会透出字形。
 */
export function ReferenceChip({ refs }: { refs: readonly ReferenceItem[] }): React.JSX.Element {
  return (
    <span
      data-testid="message-reference-pill"
      className="mx-0.5 inline-flex max-w-full items-center gap-1 rounded-pill border-(length:--hairline-width) border-hairline bg-surface px-1.5 py-0.5 leading-none text-ink align-middle"
    >
      <ReferenceChipInner refs={refs} />
    </span>
  )
}
