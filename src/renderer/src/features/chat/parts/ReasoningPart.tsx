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
 */
export interface ReasoningPartProps {
  text: string
  streaming?: boolean
}

export function ReasoningPart({ text, streaming = false }: ReasoningPartProps): React.JSX.Element {
  // 用户手动折叠/展开过就听用户的；没动过就跟流式状态走（流式期间展开、结束收起）
  const [override, setOverride] = useState<boolean | null>(null)
  const open = override ?? streaming

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
