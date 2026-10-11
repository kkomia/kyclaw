import { useState } from 'react'
import { ChevronRight, Lightbulb } from 'lucide-react'
import { cn } from '@renderer/components/ui/cn'
import { TraceFold } from './TraceFold'

/**
 * 思考块（reasoning part，round 6 改造，对照《对话UI-工具链与显示口径 v0.1》§1.3/§1.6）：
 * 只在模型吐了 reasoning 时才有这个 part —— 没有就不渲染。
 * 折叠行为：流式期间自动展开（能看到它在想什么），流结束自动收起（不占版面）；
 * 手动点一下之后听用户的（override），不再被流式状态覆盖。
 * 收起走容器级 grid-rows 过渡（TraceFold），不做条件渲染硬切；正文限高 268px 自滚。
 *
 * round 29 拆开两个语义（现场口径：模型调工具前的思考不能"工具挨工具"裸奔）：
 *   - `streaming` = **这一段自己**正在被写（标签「思考中…」+ 流光）；
 *   - `live` = **这一轮**还在流式（决定自动展开）——过程块里的思考段后面跟着工具行时，
 *     `streaming` 早就翻成 false 了（最后可渲染的是那条工具），但它还属于正在跑的过程：
 *     只要这一轮没跑完就该保持展开，否则思考段在工具行到达的瞬间自动收起 = 看不见。
 * 不传 `live` 就与 `streaming` 同档（独立思考块那条旧口径不变）。
 */
export interface ReasoningPartProps {
  text: string
  /** 这一段是当前正在写的内容（标签 + 流光） */
  streaming?: boolean
  /** 这一轮还在流式（流式期间自动展开、跑完自动收起）；不传 = 跟 streaming 同档 */
  live?: boolean
}

export function ReasoningPart({
  text,
  streaming = false,
  live
}: ReasoningPartProps): React.JSX.Element {
  // 用户手动折叠/展开过就听用户的；没动过就跟流式状态走（流式期间展开、结束收起）
  const [override, setOverride] = useState<boolean | null>(null)
  const open = override ?? live ?? streaming

  return (
    <div data-testid="reasoning-part">
      <button
        type="button"
        data-testid="reasoning-toggle"
        aria-expanded={open}
        onClick={() => setOverride(!open)}
        className="group/row flex min-h-6 w-full cursor-pointer items-center gap-2 text-left text-c1 text-ink-secondary transition-colors duration-(--motion-fast) ease-main hover:text-ink motion-reduce:transition-none"
      >
        <span
          aria-hidden="true"
          className="inline-flex size-5 shrink-0 items-center justify-center"
        >
          <Lightbulb className="size-[15px] text-ink-tertiary" />
        </span>
        <span className={cn('shrink-0', streaming && 'trace-live')}>
          {streaming ? '思考中…' : '思考过程'}
        </span>
        <ChevronRight
          aria-hidden="true"
          className={cn(
            'ml-auto size-3.5 shrink-0 text-ink-tertiary transition-[opacity,transform] duration-(--motion-fast) ease-main motion-reduce:transition-none',
            open
              ? 'rotate-90 opacity-100'
              : 'opacity-0 group-hover/row:opacity-100 group-focus-visible/row:opacity-100'
          )}
        />
      </button>
      <TraceFold open={open} className="pl-7">
        <div
          data-testid="reasoning-text"
          className="mt-1 max-h-[268px] overflow-auto text-c1 break-words whitespace-pre-wrap text-ink-tertiary [overflow-wrap:anywhere]"
        >
          {text}
        </div>
      </TraceFold>
    </div>
  )
}
