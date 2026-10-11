import { useState } from 'react'
import { ChevronRight, Lightbulb } from 'lucide-react'
import { Chip } from '@renderer/components/ui/chip'
import { cn } from '@renderer/components/ui/cn'
import { TraceFold } from './TraceFold'
import { useReasoningTranslation } from './use-reasoning-translation'

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
 *
 * round 32 接上「思考翻译」：思维链多半是英文，启用后按设置翻一遍再回显
 * （全量 / 按钮两种模式见 use-reasoning-translation）。翻译只影响**显示**：底层 part 文本、
 * 复制出去的内容与消息存储都不动；语言与目标语言一致时这一段不显示任何翻译控件。
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
  const translation = useReasoningTranslation({ text, streaming })
  const display = translation.showing ? (translation.translated ?? text) : text
  // 按钮模式的入口，或失败后的重试（全量模式翻成功了只有「原文 / 译文」那对切换）
  const action =
    translation.translated === null &&
    !translation.pending &&
    (translation.mode === 'button' || translation.error !== null)

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
        <div className="mt-1 flex flex-col gap-2">
          <div
            data-testid="reasoning-text"
            data-showing={translation.showing ? 'translated' : 'original'}
            className="max-h-[268px] overflow-auto text-c1 break-words whitespace-pre-wrap text-ink-tertiary [overflow-wrap:anywhere]"
          >
            {/* 原文 ⇄ 译文的替换：换 key 让它重挂一次，走一次淡入（雷点 5：整站不许硬切） */}
            <span
              key={translation.showing ? 'translated' : 'original'}
              className="animate-fade-in block"
            >
              {display}
            </span>
          </div>
          {translation.needed ? (
            <div
              data-testid="reasoning-translate-bar"
              className="flex animate-fade-in flex-wrap items-center gap-3"
            >
              {translation.pending ? (
                <span data-testid="reasoning-translating" className="trace-live text-c1">
                  翻译中…
                </span>
              ) : null}
              {translation.translated !== null ? (
                <>
                  <Chip
                    data-testid="reasoning-show-original"
                    aria-pressed={!translation.showing}
                    className={cn(!translation.showing && 'bg-selected')}
                    onClick={translation.showOriginal}
                  >
                    原文
                  </Chip>
                  <Chip
                    data-testid="reasoning-show-translated"
                    aria-pressed={translation.showing}
                    className={cn(translation.showing && 'bg-selected')}
                    onClick={translation.showTranslated}
                  >
                    译文
                  </Chip>
                </>
              ) : translation.pending ? null : action ? (
                <Chip
                  data-testid="reasoning-translate-action"
                  onClick={translation.request}
                  className="animate-fade-in"
                >
                  {translation.error === null ? '翻译' : '重试'}
                </Chip>
              ) : null}
              {translation.error !== null ? (
                <span
                  data-testid="reasoning-translate-error"
                  className="animate-fade-in text-c1 text-danger"
                >
                  {translation.error}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      </TraceFold>
    </div>
  )
}
