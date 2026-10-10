import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@renderer/components/ui/cn'

/**
 * 思考块（reasoning part）：只在模型吐了 reasoning 时才有这个 part —— 没有就不渲染。
 * 折叠行为：流式期间自动展开（能看到它在想什么），流结束自动收起（不占版面）；
 * 手动点一下之后听用户的（override），不再被流式状态覆盖。
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
    <div data-testid="reasoning-part" className="flex flex-col">
      <button
        type="button"
        data-testid="reasoning-toggle"
        aria-expanded={open}
        onClick={() => setOverride(!open)}
        className="flex items-center gap-1 self-start rounded-control px-1.5 py-0.5 text-c1 text-ink-tertiary transition-colors duration-(--motion-fast) hover:bg-hover hover:text-ink-secondary"
      >
        <ChevronRight
          aria-hidden="true"
          className={cn(
            'size-3.5 transition-transform duration-(--motion-fast)',
            open && 'rotate-90'
          )}
        />
        {streaming ? '思考中…' : '思考过程'}
      </button>
      {open ? (
        <div
          data-testid="reasoning-text"
          className="animate-fade-in mt-1 text-c1 break-words whitespace-pre-wrap text-ink-tertiary"
        >
          {text}
        </div>
      ) : null}
    </div>
  )
}
