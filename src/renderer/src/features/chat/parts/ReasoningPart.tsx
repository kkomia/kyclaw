import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
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
 * round 88 追加 `settled`（用户现场口径：思考写完了就把版面让开）：
 *   一段思考后面**已经出现别的内容**（工具行 / 正文 / 下一段思考）时，这一段自动收起 ——
 *   判据是"后面有东西上屏"，不是"整轮跑完"；正在写的那一段（后面什么都没有）不收。
 *   只收**一次**：用户之后点开就听用户的，不因为每次 rerender 把他压回去。
 *   不传 `settled` 的旧调用点行为不变（整轮跑完才收）。
 *
 * round 32 接上「思考翻译」：思维链多半是英文，启用后按设置翻一遍再回显
 * （全量 / 按钮两种模式见 use-reasoning-translation）。翻译只影响**显示**：底层 part 文本、
 * 复制出去的内容与消息存储都不动；语言与目标语言一致时这一段不显示任何翻译控件。
 *
 * round 88：正文限高那一层（`reasoning-text`，268px 自滚）自己也要跟随 —— 外层的
 * MessageList 跟随管不到内滚容器，长思考在界面上表现为"想了一半就不动了"（用户反馈）。
 * 口径与 MessageList 同一套（贴底跟随 / 上翻暂停 / 回底恢复），另加一条：布局变化
 * （第一次溢出、折叠重开、文本换人、窗口 resize）只**纠正位置**，不借机重排阅读位置。
 */

/** 贴底阈值（px）：离底超过它就算"用户在翻这段思考" */
const STICK_THRESHOLD = 40

/** 视口挤到这个高度以下就不再动位置（折叠过渡那一档：内容看不见，写下去只是在跟布局较劲） */
const COLLAPSED_HEIGHT = 4

/**
 * 思考块内滚容器的跟随：贴底就跟着新内容走，用户上翻就停下，自己滚回底再贴上。
 *
 * 光标（`last`）记的是**我们上一次确认过的 scrollTop**：
 *   - `null` = 还没量过 → 量到就贴底（第一次溢出时"直接看最新一行"，不是停在顶部）；
 *   - 量过之后两条路：贴底的人跟到底（内容长了就跟、短了就退回来），上翻的人位置不动
 *     （布局突变把 scrollTop 归零时，按上次位置纠回合法范围 —— 这就是"不抢阅读位置"）。
 * 判断只用**写之前那一刻**的几何：真浏览器里 scrollTop 是引擎按几何裁剪过的值，
 * 读它只为了"别写没必要的值"，跟不跟到底由 `sticky` 自己说了算。
 *
 * 两类触发，各管一段：
 *   - 正文/显示文本换了（`anchor`）→ 跟到底或守住位置；
 *   - 几何变了（`ResizeObserver`，含窗口 resize、折叠重开；jsdom 没有就退成按帧比几何）
 *     → 把上次确认的位置**收进合法范围 / 跟到新底**，不借机跳到别处。
 *
 * 视口被压到 0（折叠过渡）时**只记意图、不写位置**：那一刻内容在看不着的地方，
 * 按"0 高度视口"写出来的值（= 全部内容高度）会先把位置顶到别处，重开时才开始纠回来
 * —— 真机上表现为折一次跳一下（e2e 探针实测到的就是这个）。
 *
 * 容器是**收起状态下才上 DOM** 的（TraceFold 的 everOpened）：节点晚挂一次就必须补挂观察者，
 * 所以观察者那条 effect 依赖的是节点本身，不是空依赖数组。
 */
function useReasoningScroll(anchor: string): (node: HTMLDivElement | null) => void {
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  /** 上一次确认过的 scrollTop（null = 还没量过） */
  const last = useRef<number | null>(null)
  const sticky = useRef(true)
  /** 是我们自己写的位置：随之而来的 scroll 事件不是用户在上翻 */
  const writing = useRef(false)

  /** 跟随状态挂到 DOM 上（排障用：出问题时一眼看出"是没跟、还是跟错了"） */
  const stamp = (view: HTMLDivElement | null): void => {
    if (view === null) return
    view.dataset.follow = sticky.current ? 'bottom' : 'hold'
    view.dataset.followLast = String(last.current)
  }

  /** 把位置收在"该在的地方"：贴底的人跟到底，上翻的人守住上次的值（夹在合法范围内） */
  const settle = useCallback((view: HTMLDivElement): void => {
    const max = Math.max(0, view.scrollHeight - view.clientHeight)
    const top = sticky.current ? max : Math.min(last.current ?? view.scrollTop, max)
    last.current = top
    // 折叠过渡那一档（视口被压到 0）：只记意图，不写位置
    if (view.clientHeight <= COLLAPSED_HEIGHT) return
    if (view.scrollTop !== top) {
      writing.current = true
      view.scrollTop = top
      queueMicrotask(() => {
        writing.current = false
      })
    }
    stamp(view)
  }, [])

  useLayoutEffect(() => {
    if (container === null) return
    settle(container)
  }, [anchor, container, settle])

  useLayoutEffect(() => {
    if (container === null) return
    /** 几何真变了才重算：纯渲染不碰滚动位置 */
    const remeasure = (): void => settle(container)
    if (typeof ResizeObserver === 'undefined') {
      let width = container.clientWidth
      let height = container.clientHeight
      let frame = requestAnimationFrame(function tick(): void {
        frame = requestAnimationFrame(tick)
        if (container.clientWidth === width && container.clientHeight === height) return
        width = container.clientWidth
        height = container.clientHeight
        remeasure()
      })
      return () => cancelAnimationFrame(frame)
    }
    const observer = new ResizeObserver(remeasure)
    observer.observe(container)
    return () => observer.disconnect()
  }, [container, settle])

  /** 用户滚动 = 位置**变了**、且不是我们自己写的那一次 */
  useEffect(() => {
    if (container === null) return
    const onScroll = (): void => {
      if (writing.current) return
      sticky.current =
        container.scrollHeight - container.scrollTop - container.clientHeight < STICK_THRESHOLD
      last.current = container.scrollTop
      stamp(container)
    }
    container.addEventListener('scroll', onScroll, { passive: true })
    return () => container.removeEventListener('scroll', onScroll)
  }, [container])

  return setContainer
}

export interface ReasoningPartProps {
  text: string
  /** 这一段是当前正在写的内容（标签 + 流光） */
  streaming?: boolean
  /** 这一轮还在流式（流式期间自动展开、跑完自动收起）；不传 = 跟 streaming 同档 */
  live?: boolean
  /**
   * 「这一段已经写完了，后面已经有别的东西上屏」（工具行 / 正文 / 下一段思考）：
   * 到这一档就把思考框收起来，把版面让给新的内容。只自动收**一次** ——
   * 之后用户再点开就听用户的，不因为每次 rerender 重新压回去。
   */
  settled?: boolean
  /**
   * 受控的手动开合（`true`/`false` = 用户点过；`null`/不传 = 没点过、跟自动档走）。
   *
   * 为什么要受控：消息的渲染形态会变（纯思考 → 加进来一条工具行就换成过程块），
   * **组件类型一变整棵子树重挂**，本地 state 会丢。用户手动点开过的那一段在工具到达时
   * 不能又被自动折叠压回去，所以这份选择由 `Message` 按 part 原始下标持有、透传下来。
   * 不传（自己管自己）的老用法一字不变。
   */
  override?: boolean | null
  /** 用户点了开/合：报给上层存（受控时用它，不再用本地 state） */
  onToggle?: (nextOpen: boolean) => void
}

export function ReasoningPart({
  text,
  streaming = false,
  live,
  settled = false,
  override: controlledOverride,
  onToggle
}: ReasoningPartProps): React.JSX.Element {
  // 用户手动折叠/展开过就听用户的；没动过就跟流式状态走（流式期间展开、结束收起）
  const [ownOverride, setOwnOverride] = useState<boolean | null>(null)
  const override = controlledOverride === undefined ? ownOverride : controlledOverride
  // 「后面有内容了」这只自动收一次（渲染期按 props 调整 state，同 TraceFold 的写法：
  // React 会在提交前用新值重渲染，不走 effect 就没有"先开着再收一下"的闪）
  const [autoCollapsed, setAutoCollapsed] = useState(false)
  if (settled && !autoCollapsed && override === null) setAutoCollapsed(true)
  const open = override ?? (autoCollapsed ? false : (live ?? streaming))
  const toggle = useCallback((): void => {
    const next = !open
    if (onToggle === undefined) setOwnOverride(next)
    else onToggle(next)
  }, [open, onToggle])
  const translation = useReasoningTranslation({ text, streaming })
  const display = translation.showing ? (translation.translated ?? text) : text
  // 内滚容器自己的跟随（round 88）：正文换了、或显示的那一份换了，都按"贴底/上翻"的老规矩收位置
  const reasoningRef = useReasoningScroll(`${streaming ? 'live' : 'done'}:${display}`)
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
        onClick={toggle}
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
            ref={reasoningRef}
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
