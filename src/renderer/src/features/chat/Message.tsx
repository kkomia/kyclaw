import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { UIMessage } from 'ai'
import { useEffectiveMotion } from '@renderer/lib/motion'
import { animateSendFlight } from './send-flight'
import {
  Check,
  Copy,
  FileText,
  Image as ImageIcon,
  Paperclip,
  Pencil,
  RefreshCw,
  TextQuote,
  Undo2
} from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { cn } from '@renderer/components/ui/cn'
import { Dialog } from '@renderer/components/ui/dialog'
import { EMPTY_CITATION_HINTS } from './citation-hints'
import {
  EMPTY_CITATIONS,
  extractCitationsFromTexts,
  knownSourcesOfParts,
  type Citation,
  type CitationHint
} from './citations'
import { SourcesAction, SourcesPanel } from './SourcesPanel'
import {
  ContextMenu,
  type ContextMenuCloseReason,
  type ContextMenuItem,
  type ContextMenuState
} from '@renderer/features/workbench/ContextMenu'
import { DeliverableCard } from './DeliverableCard'
import { deliverableOf, deliverablesOfMessage, type Deliverable } from './deliverable'
import { ImageLightbox } from './ImageLightbox'
import { MessageAction, MessageActions, MessageActionsDivider } from './MessageActions'
import {
  readSentAt,
  rememberVerifiedSeal,
  resolveUserDisplay,
  sameVerificationMaterial,
  sentAtLabel,
  verifiedVerdictOf,
  verifySegmentDigests
} from './message-context'
import type { ContextEntry, VerificationMaterial } from './message-context'
import {
  reasoningOrdinalsOf,
  withReasoningChoice,
  type ReasoningOverrides
} from './reasoning-overrides'
import { TextPart } from './parts/TextPart'
import { TurnProcess, type TurnProcessEntry } from './parts/TurnProcess'
import { TurnLatestStatus } from './parts/TurnLatestStatus'
import { isToolPart, toToolCardPart } from './parts/tool-part'
import { parseReferenceMarkers } from './reference-markers'
import { ReferenceChip } from './reference-chip'

/**
 * 一条消息（用户 / 助手两种形态）。
 * 用户消息：右侧气泡 + 悬停出现的动作行（「编辑」= 截断重发，见 ChatPage 的 editResend；
 * 「撤回」= 确认后把这条及之后的对话从上下文与列表里去掉、原文放回输入框，见 ChatPage 的 undoMessage）；
 * 助手消息：左对齐的 part 流 —— 正文文本单出，**连续的过程 part（思考 / 工具调用）并成
 * 一个过程块**（round 6：TraceBlock，正文把块切开、块内保持原顺序）；
 * **正文下方**另有一行动作（round 61）：「复制」= 正文 parts 的拼接，「重新生成」= 同一条重试路径。
 * 0.1.3 返工：网页来源入口也收进这一行（与复制 / 重新生成同一水平线，icon-only）；
 * **顺序固定为 复制 → 重新生成 → 单竖线 → 来源**（来源入口在最后；只有来源时不留孤竖线），
 * 展开列表本身仍在消息末尾、交付卡之后，不在正文后再重复一枚入口。
 * round 63：动作一律是**图标按钮**（编辑 / 撤回 / 复制 / 重新生成 / 网页来源入口）——钮上不写字，
 * 名字只走 `aria-label` 与 `title`（详见 MessageAction 的头注）。
 * round 29：审批入口不在这条链上（待审批统一走输入框上方的 ApprovalDock，块内只留只读状态行）。
 * round 50：交付（deliver_file 的结果）单出一张卡 —— 它是"给用户看的东西"，不埋进会收起的
 * 过程块里；0.1.3 / 014 起改为整轮汇总到消息末尾（见 chunkParts 与 MessageProps.deliverables）。
 *
 * round 61 的两条口径（动作行的可见性都在上层算好，这里只管画）：
 *   - **流式中的那条不显示动作行**（内容还在长，复制/重生成都没意义）；等审批 / 压缩中同理，
 *     由 ChatPage 不给回调来关掉（与「编辑」同一道闸）；
 *   - 「重新生成」只在**最后一条助手消息**上出现（谁拿到回调由 MessageList 判）。
 *
 * 0.1.3 / 006 + 008（用户气泡的展示）：附件 / 摘选的追加段要在**异步 SHA-256 复核通过之后**
 * 才从气泡里藏掉（pending、复核失败、超时一律按原文）；气泡下方统一画文件 / 摘选图标项
 * （图片仍在原来的缩略图位置：固定尺寸 + `object-contain`，点开走共用 lightbox，不重复）；
 * 悬停 / 键盘焦点气泡出本地发送时间 ——
 * **008 返工后是裸文字**（无背景、无边框、无气泡），时间来源与文案口径不变
 * （"精确发送时刻"与"记录时间"两种来源 —— 见 features/chat/message-context）。
 *
 * 0.1.3 / 013 返工：选中助手正文后右键，菜单可把选中的原文**引用到输入卡**（草稿附件：
 * 输入框不占位、卡上摘要可展开 / 编辑；发送仍带原文，不自动发送）或复制。菜单复用右侧预览的
 * ContextMenu 形态；只拦"有选区"的右键 —— 普通复制（Ctrl+C）、表格复制 / 下载按钮的左键动作
 * 都不受影响。
 *
 * 0.1.3 / 014：交付卡从 part 位置摘掉，整轮汇总到**本条消息末尾**（多条连续助手消息时由
 * MessageList 只交给最后一条，见 deliverable.ts 的 deliverablesByTurnTail）。不依赖 deliver
 * 是不是最后一个工具调用，也不会嵌进中间思考 / 工具段。
 */
export interface MessageProps {
  message: UIMessage
  /** 这一条正在流式（最后一条助手消息且会话处于 streaming） */
  streaming?: boolean
  /**
   * P1b：这条用户消息是**刚刚发送**的（本轮非 ready 的最后一条用户消息）。
   * true 时给用户气泡挂 320ms 右下 origin 的入场动画；历史回灌不播（不逐条烟花）。
   */
  animateSend?: boolean
  onEdit?: (messageId: string, text: string) => void
  /** 撤回到这条用户消息（确认后截断并移除这条及其后的消息，原文放回输入框） */
  onUndo?: (messageId: string, text: string) => void
  /** 重新生成这一条助手回复（只有最后一条助手消息会拿到；闸门关时上层不给） */
  onRegenerate?: () => void
  /**
   * 整轮汇总的交付物（0.1.3 / 014）：由 MessageList 按"连续助手消息"算好，只交给这一轮的
   * **最后一条助手消息**；非末条传空数组（显式压掉自己的卡）。省略 = 只看这一条自己的 parts
   * （独立渲染 Message 的既有用法）。
   */
  deliverables?: readonly Deliverable[]
  /**
   * 选中助手正文 →「引用到输入框」（0.1.3 / 013）。给了才挂选文菜单；不自动发送 ——
   * 上层只把引用草稿交给输入卡（见 ChatPage 的 quoteSelection）。
   */
  onQuoteSelection?: (text: string) => void
  /**
   * 本轮（同一用户消息之后连续 assistant 消息）的已知来源 allowlist（0.1.3 网页引用）。
   * 由 MessageList 合并后传入；省略 = 只看这一条自己的工具 part（独立渲染 Message 的既有用法）。
   * **键存在即授权**：正文数字链接必须命中这里才出角标。
   */
  knownSources?: ReadonlyMap<string, CitationHint>
  /**
   * 本轮末尾汇总的来源（由 MessageList 按整轮正文算好，只交给轮末那条 assistant 消息）。
   * 显式传空数组会压掉本条自己的来源入口与列表；省略 = 只看这一条自己的正文（独立渲染用法）。
   * 流式期间无论传什么，Message 都不展示来源入口。
   */
  citationSources?: readonly Citation[]
}

type MessagePart = UIMessage['parts'][number]
type TextPartType = Extract<MessagePart, { type: 'text' }>
type FilePartType = Extract<MessagePart, { type: 'file' }>

/** 「已复制」这个反馈保持多久（到点把图标从对勾退回复制、名字退回「复制」） */
const COPIED_RESET_MS = 1500

/**
 * 一次"验过才藏"的结论（006 / 138 裁决）：`review` 是核验时**那批材料本身**（段 + 摘要），
 * 判断"还是不是同一批"用 `sameVerificationMaterial` 逐字比 —— 不用 message.id（同 id 编辑）、
 * 也不用弱指纹（拿指纹当身份就会把改过的正文当成验过的）。
 */
interface SealState {
  review: VerificationMaterial
  verified: boolean
}

/** 已通过缓存里的结论（只缓存通过；渲染期直接读，省掉重挂时的一帧原文闪） */
function cachedSealState(review: VerificationMaterial): SealState | null {
  return verifiedVerdictOf(review) === true ? { review, verified: true } : null
}

/** 一个选区端点所在的**可见正文容器**（TextPart 的 message-text）；不在正文里回 null */
function bodyTextContainerOf(node: Node): HTMLElement | null {
  const element = node instanceof Element ? node : node.parentElement
  return element?.closest<HTMLElement>('[data-testid="message-text"]') ?? null
}

/**
 * 当前选区里的文字 —— 只有**整段选区都落在同一个正文容器里**才算数（0.1.3 / 013）。
 *
 * 为什么不能只看"在 article 里"：article 还包含过程块（工具 / 思考，收起后文本仍在 DOM）
 * 和交付卡；`Range.toString()` 会把跨过去的工具名、状态、输出、隐藏思考一起带进引用草稿。
 * 这里要求起点 / 终点同属一个 `message-text`，跨正文段、跨过程块、跨交付卡、折叠内容
 * 一律不接管右键（宁可拒绝，也不混入不可见文本）。
 */
function selectionTextWithin(container: HTMLElement): string | null {
  const selection = window.getSelection()
  if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return null
  const range = selection.getRangeAt(0)
  const start = bodyTextContainerOf(range.startContainer)
  const end = bodyTextContainerOf(range.endContainer)
  if (start === null || start !== end) return null
  if (!container.contains(start)) return null
  const text = selection.toString()
  return text.trim() === '' ? null : text
}

/** 用户消息里的纯文本（气泡里不渲染 markdown：用户输入按原样显示） */
function userText(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n\n')
}

/** 上下文图标项的图标表（0.1.3 / 006）：文件 / 摘选 / 图片各自一枚，图标本身只是装饰 */
const CONTEXT_ICONS: Record<ContextEntry['kind'], typeof FileText> = {
  file: FileText,
  quote: TextQuote,
  image: ImageIcon
}

/**
 * 气泡**下方**的上下文图标项（0.1.3 / 006）：细描边圆角 pill + 图标 + 名称。
 * 画的是"这条消息真带出去的文件 / 摘选"（来源见 message-context 的 metadata），
 * 与输入卡里那枚引用 chip 观感一致但语义不同：那枚是输入里内联的标记，这枚是随消息发出去的载荷。
 * 名称一律写字（用户口径：没要求去掉名称）；完整来源（绝对路径 / 相对路径）走 title。
 */
function ContextItem({ entry }: { entry: ContextEntry }): React.JSX.Element {
  const Icon = CONTEXT_ICONS[entry.kind]
  const where = entry.absolute ?? entry.source
  const title =
    entry.lines === undefined ? where : `${where}（第 ${entry.lines.start}–${entry.lines.end} 行）`
  return (
    <span
      data-testid="message-context-item"
      data-kind={entry.kind}
      title={title}
      className="inline-flex h-7 max-w-60 items-center gap-1.5 rounded-pill border-(length:--hairline-width) border-hairline px-2.5 text-c1 text-ink-secondary"
    >
      <Icon aria-hidden="true" className="size-3.5 shrink-0 text-ink-tertiary" />
      <span className="min-w-0 truncate">{entry.name}</span>
      {entry.lines === undefined ? null : (
        <span className="shrink-0 text-ink-tertiary">
          {`第 ${entry.lines.start}–${entry.lines.end} 行`}
        </span>
      )}
    </span>
  )
}

/** 助手消息的正文（复制取它：**不含**思考 / 工具 / 文件 part） */
function assistantText(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n\n')
}

/** 用户消息里的 file part（模块 2：图片随消息发出去就是它们） */
function userFiles(message: UIMessage): FilePartType[] {
  return message.parts.filter((part): part is FilePartType => part.type === 'file')
}

/**
 * 用户气泡上方的图片缩略图（0.1.3 / 006 返工）：**固定 96×96 的框** + `object-contain`，
 * 原图多大、横竖都不改变缩略图尺寸，也不裁切内容（小图不撑大、大图不撑破气泡）。
 * 点开走共用的 `ImageLightbox`（右上角关闭钮 / 点遮罩空白 / Esc 都能关，焦点由 Radix 管）。
 * `src` 直接用消息里那个 file part 的真实 data URL —— 这里只改展示，不动图片载荷。
 */
function MessageImage({ part }: { part: FilePartType }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const name = part.filename ?? '图片'
  return (
    <>
      <button
        type="button"
        data-testid="message-image-open"
        aria-label={`放大查看 ${name}`}
        aria-haspopup="dialog"
        title={name}
        onClick={() => setOpen(true)}
        className="size-24 shrink-0 cursor-zoom-in overflow-hidden rounded-panel border-(length:--hairline-width) border-surface-border bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-text"
      >
        <img
          data-testid="message-image"
          src={part.url}
          alt={name}
          draggable={false}
          className="block size-full object-contain"
        />
      </button>
      <ImageLightbox
        open={open}
        onOpenChange={setOpen}
        src={part.url}
        name={name}
        testId="message-image-lightbox"
      />
    </>
  )
}

/** 最后一个"真渲染出来"的 part 的下标（光标挂它身上）；没有就是 -1 */
function lastRenderableIndex(parts: UIMessage['parts']): number {
  let last = -1
  parts.forEach((part, index) => {
    if (part.type === 'text' || part.type === 'reasoning' || isToolPart(part)) last = index
  })
  return last
}

/**
 * 这个 part 是不是**看得见的内容**（用来判"这一段后面已经有内容上屏了"）。
 *
 * 与 `lastRenderableIndex` 的区别只有空正文这一处，但这一处会咬人：SSE 的 `text-start` 会先落一个
 * **空 text part**（`TextPart` 那时只画一枚流式光标、没有一个字，见 TextPart 的 `text === ''` 分支），
 * 拿它当"内容出现了"会把思考块在正文还没开始时就被收掉 —— 用户口径是"下一个工具或**其他内容**显示时"。
 * 所以这里要求正文真有字（空白也算没字）；工具 part 直接算（工具卡一出现就有名字与状态行）；
 * reasoning part 也算（它自己就是"内容"，只是会在自己的 `settled` 里再判一次）。
 */
function hasVisibleContent(part: UIMessage['parts'][number]): boolean {
  if (part.type === 'text') {
    const text: unknown = part.text
    return typeof text === 'string' && text.trim() !== ''
  }
  return part.type === 'reasoning' || isToolPart(part)
}

/**
 * 助手消息的渲染块：文本一节，连续的过程 part 并成一个过程块。
 *
 * 交付卡不再在这里成块（0.1.3 / 014）：它整轮汇总到消息**末尾**统一渲染（见 Message 的
 * `deliverables` 与 deliverable.ts 的 deliverablesByTurnTail）。已完成的 deliver_file 从
 * 过程流里直接跳过（它已在末尾有卡，不该再以工具行重复出现）；还在调用中的 deliver_file
 * （没有结果）照旧走过程块里的普通工具行。
 */
type RenderChunk =
  | { kind: 'text'; part: TextPartType; index: number }
  | { kind: 'process'; entries: TurnProcessEntry[] }

function chunkParts(parts: UIMessage['parts'], streaming: boolean): RenderChunk[] {
  const lastIndex = lastRenderableIndex(parts)
  // "后面已经有内容上屏"的分界：**空正文不算**（见 hasVisibleContent）
  let lastVisibleIndex = -1
  parts.forEach((part, index) => {
    if (hasVisibleContent(part)) lastVisibleIndex = index
  })
  const chunks: RenderChunk[] = []
  parts.forEach((part, index) => {
    if (part.type === 'text') {
      chunks.push({ kind: 'text', part, index })
      return
    }
    if (part.type === 'reasoning' || isToolPart(part)) {
      const tool = toToolCardPart(part)
      const deliverable = tool === null ? null : deliverableOf(tool)
      if (deliverable !== null) return
      const entry: TurnProcessEntry = {
        part,
        index,
        streaming: streaming && index === lastIndex,
        // 这一段后面已经有别的内容上屏了（工具行 / 正文 / 下一段思考）→ 思考框收起来让版面。
        // 判据用 lastVisibleIndex 而不是 lastIndex：只有一枚流式光标的空正文不算"内容"
        settled: index < lastVisibleIndex
      }
      const previous = chunks[chunks.length - 1]
      if (previous?.kind === 'process') previous.entries.push(entry)
      else chunks.push({ kind: 'process', entries: [entry] })
    }
    // step-start / file / source 等不渲染
  })
  return chunks
}

export function Message({
  message,
  streaming = false,
  animateSend = false,
  onEdit,
  onUndo,
  onRegenerate,
  deliverables,
  onQuoteSelection,
  knownSources: knownSourcesProp,
  citationSources: citationSourcesProp
}: MessageProps): React.JSX.Element | null {
  // null = 不在编辑；string = 编辑中的草稿
  const [draft, setDraft] = useState<string | null>(null)
  /** 撤回的二次确认弹窗（Kimi 口径：撤销会连带清掉这条之后的所有内容，先说清楚再动） */
  const [undoOpen, setUndoOpen] = useState(false)
  /** 助手正文刚被复制（图标短暂转对勾、名字短暂转「已复制」，到点退回） */
  const [copied, setCopied] = useState(false)
  /** 网页来源列表的开合（入口在动作行，列表留在消息末尾；只有轮末那条会拿到 sources） */
  const [sourcesOpen, setSourcesOpen] = useState(false)
  /** 来源列表 id（动作行入口的 aria-controls 与列表共用） */
  const sourcesListId = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  /** 助手正文的选文菜单（0.1.3 / 013；null = 没开） */
  const [selectionMenu, setSelectionMenu] = useState<ContextMenuState | null>(null)
  /** 菜单关闭后要还焦点的那一侧（打开前 focus 的元素；body 不记，回落到消息本体） */
  const menuReturnFocus = useRef<HTMLElement | null>(null)
  /** 这一下点的是哪个动作：只有「复制」关闭后才还焦点；「引用」交给 Composer 接管 */
  const menuAction = useRef<'quote' | 'copy' | null>(null)
  const restoreMenuFocus = useRef(false)
  /** 选中消息本体（article）：没有可还焦点的 invoker 时用它接住 */
  const articleRef = useRef<HTMLElement | null>(null)
  /** 稳定引用：菜单开着时流式消息会持续重渲染，ContextMenu 的监听 effect 不该跟着重挂 */
  const closeSelectionMenu = useCallback((reason?: ContextMenuCloseReason): void => {
    const action = menuAction.current
    restoreMenuFocus.current = reason === 'escape' || (reason === 'item' && action === 'copy')
    menuAction.current = null
    setSelectionMenu(null)
  }, [])
  /** 菜单卸载后再还焦点（引用那一路 restore=false，Composer 的 caretToken effect 会接管） */
  useEffect(() => {
    if (selectionMenu !== null || !restoreMenuFocus.current) return
    restoreMenuFocus.current = false
    const target = menuReturnFocus.current
    if (target !== null && target.isConnected) target.focus()
    else articleRef.current?.focus()
  }, [selectionMenu])
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /**
   * 思考段的手动开合：消息的渲染形态会变（纯思考 → 加进来一条工具行就换成过程块），
   * **组件类型一变整棵重挂**，思考块自己的 state 会丢。用户手动点开过的那一段，
   * 在工具到达后不能被自动折叠再压回去 —— 所以这份选择存在这一层。
   * 段身份 = **消息内 reasoning 序号**（工具插入不改它；两段同样正文也各算一段），见 `reasoning-overrides`。
   */
  const [reasoningOverrides, setReasoningOverrides] = useState<ReasoningOverrides>(() => new Map())
  const [overridesOwner, setOverridesOwner] = useState(message.id)
  /** 动效 B：消息气泡入场（flight=真实气泡从 Composer rect 飞上来；grow=CSS 原地长出来） */
  const motion = useEffectiveMotion()
  const bubbleRef = useRef<HTMLDivElement | null>(null)
  const sendAnimate = animateSend && motion.chatSend ? motion.messageEnter : undefined
  useLayoutEffect(() => {
    if (sendAnimate !== 'flight') return
    const bubble = bubbleRef.current
    if (bubble === null) return
    const animation = animateSendFlight(bubble)
    // 量不到 Composer rect（切窗/空会话）→ 退回 CSS grow，而不是"凭空出现"
    if (animation === null)
      bubble.closest('[data-role="user"]')?.setAttribute('data-send-animate', 'grow')
  }, [sendAnimate])
  // 同一个组件实例换成另一条消息（列表复用 / 列表被顶掉）：上一条的手动开合不许跟过去。
  // 渲染期按 props 调整 state（同 TraceFold 的写法）：提交前就带上新值，不会多画一帧旧状态。
  if (overridesOwner !== message.id) {
    setOverridesOwner(message.id)
    setReasoningOverrides(new Map())
  }
  /** 每个 part 下标 → 它是第几段思考（这一轮渲染的段身份） */
  const reasoningOrdinals = useMemo(() => reasoningOrdinalsOf(message.parts), [message.parts])

  /**
   * 网页引用（0.1.3 · P0 provenance）：正文数字链接只有命中**已完成工具结果**的 allowlist
   * 才是来源；allowlist 优先用 MessageList 按本轮合并的那份，独立渲染时回落到本条自己的
   * 工具 part。工具结果只补 title/snippet 并授权正文引用；没有正文数字链接就不会变成来源。
   *
   * 文本按 part 分别提取（不是 join 后提取）：每个 part 在渲染时是独立 Markdown 实例，
   * 未闭合围栏 / 行内 code 不该跨 part 传染。流式期间不算来源，面板因此整段不出现。
   */
  const assistantBodyText = assistantText(message)
  const assistantBodyTexts = useMemo(
    () =>
      message.role === 'assistant'
        ? message.parts
            .filter((part): part is TextPartType => part.type === 'text')
            .map((part) => part.text)
        : [],
    [message.role, message.parts]
  )
  const ownKnownSources = useMemo(
    () =>
      message.role === 'assistant' && knownSourcesProp === undefined
        ? knownSourcesOfParts(message.parts)
        : EMPTY_CITATION_HINTS,
    [message.role, message.parts, knownSourcesProp]
  )
  const knownSources = knownSourcesProp ?? ownKnownSources
  const ownSources = useMemo(
    () =>
      message.role === 'assistant' && !streaming && citationSourcesProp === undefined
        ? extractCitationsFromTexts(assistantBodyTexts, knownSources)
        : EMPTY_CITATIONS,
    [message.role, streaming, citationSourcesProp, assistantBodyTexts, knownSources]
  )
  const sources = streaming ? EMPTY_CITATIONS : (citationSourcesProp ?? ownSources)
  /**
   * 来源列表跟着来源走：流式期间 / 本轮没有来源时收起。否则一轮重生成结束后，
   * 上一次展开的列表会自己弹回来（旧组件靠 key 重挂清状态，现在状态在本层）。
   * 渲染期按 props 重置（同 overridesOwner）：提交前就带上收起的值，不经过 effect。
   */
  if (sources.length === 0 && sourcesOpen) setSourcesOpen(false)

  /** 记一段思考的手动开合（顺手清掉已经换了一段的旧记录，见 withReasoningChoice） */
  const rememberReasoningChoice = useCallback(
    (ordinal: number, text: string, open: boolean): void => {
      setReasoningOverrides((current) =>
        withReasoningChoice(current, message.parts, reasoningOrdinals, ordinal, { open, text })
      )
    },
    [message.parts, reasoningOrdinals]
  )

  useEffect(() => {
    return () => {
      if (copyTimer.current !== null) clearTimeout(copyTimer.current)
    }
  }, [])

  /**
   * 用户消息的展示面（0.1.3 / 006 + 008）：追加段藏在哪、气泡下方画哪几个图标项、发送时间是多少。
   *
   * **验过才藏**（138 裁决）：这里同步算出来的只是**候选**（同步一阶：段长 + 头尾摘录 + 分隔符），
   * 正文默认按原文显示；下面的 effect 把每一段真算一遍 SHA-256、全对上了才切到"藏"。
   * 任何异常（摘要算不出 / 对不上 / 超时）都停在原文 —— 不接受"先藏后验"。
   * 结论身份 = **材料本身**（段 + 摘要逐字比，见 sameVerificationMaterial）：同一条消息被编辑、
   * 或旧身份的异步结果晚回来，都比不上 → 回到 pending（按原文）。
   */
  const display = useMemo(
    () => resolveUserDisplay({ text: userText(message), metadata: message.metadata }),
    [message]
  )
  /** 待核验材料（数组身份随 display 走，按 message 记忆） */
  const review = display.review
  /** null = 还没复核完（**按原文显示**）；材料相符且 verified 时才按候选隐藏 */
  const [seal, setSeal] = useState<SealState | null>(() => cachedSealState(review))
  // 材料换了（同 id 编辑 / 换了一条消息）：上一条的结论不许跟过去（渲染期调整，同 overridesOwner）
  if (seal !== null && !sameVerificationMaterial(seal.review, review)) {
    setSeal(cachedSealState(review))
  }
  /** 现读材料不需要 ref：换材料时下面这条 effect 会重跑，旧那条靠 cleanup 的 alive 标记作废 */
  useEffect(() => {
    if (review.length === 0) return
    if (verifiedVerdictOf(review) === true) return
    let alive = true
    void verifySegmentDigests(review).then((verified) => {
      // 材料在这期间被换掉（同 id 编辑 / 换了消息）：旧材料的晚到结果一律丢掉
      if (!alive) return
      if (verified) rememberVerifiedSeal(review)
      setSeal({ review, verified })
    })
    return () => {
      alive = false
    }
  }, [review])

  if (message.role === 'user') {
    const text = userText(message)
    const files = userFiles(message)
    /** 图片走固定尺寸缩略图（模块 2，点击放大）；非图片 file part 与上下文图标项一起排在气泡下方 */
    const images = files.filter((part) => part.mediaType.startsWith('image/'))
    const fileParts = files.filter((part) => !part.mediaType.startsWith('image/'))
    /** 只有"复核通过（或缓存里已通过）"才隐藏；pending 与失败一律按原文 */
    const sealVerified =
      seal !== null && sameVerificationMaterial(seal.review, review) && seal.verified
    const visible = display.hidden && sealVerified
    const bodyText = visible ? display.text : text
    /** 被藏掉的上下文条目：图片不在下方重复画（缩略图就是它的呈现） */
    const contextItems = visible ? display.entries.filter((entry) => entry.kind !== 'image') : []
    const sentAt = readSentAt(message.metadata)
    const submitEdit = (): void => {
      const next = (draft ?? '').trim()
      setDraft(null)
      if (next !== '' && next !== text) onEdit?.(message.id, next)
    }

    /**
     * 气泡那一列（气泡 / 上下文图标项 / 动作行 + 发送时间）。
     *
     * 008 返工（2026-10-17 用户口径）：发送时间是**裸文字**（无背景 / 无边框 / 无圆角），
     * 与动作行同一行、靠右；悬停这一条消息或在其中聚焦时显形 —— 不再套 Tooltip 气泡。
     * 时间来源与文案口径不变：`kyclawSentAt` = 精确发送时刻，`createdAt` = 记录时间
     * （文案带「（记录时间）」限定，见 sentAtLabel）。
     * 旧消息没有可靠时间（sentAt === null）时不画时间、也不占 tab 位（不编造）。
     */
    const actions =
      onEdit || onUndo ? (
        <MessageActions>
          {onEdit ? (
            <MessageAction testId="message-edit" label="编辑" onClick={() => setDraft(text)}>
              <Pencil aria-hidden="true" className="size-4" />
            </MessageAction>
          ) : null}
          {onUndo ? (
            <MessageAction testId="message-undo" label="撤回" onClick={() => setUndoOpen(true)}>
              <Undo2 aria-hidden="true" className="size-4" />
            </MessageAction>
          ) : null}
        </MessageActions>
      ) : null
    const sentAtNode =
      sentAt === null ? null : (
        <span
          data-testid="message-sent-at"
          data-font-role="code"
          className="shrink-0 font-mono whitespace-nowrap text-c1 text-ink-tertiary tabular-nums opacity-0 transition-opacity duration-(--motion-fast) ease-main group-hover:opacity-100 group-focus-within:opacity-100 motion-reduce:transition-none"
        >
          {sentAtLabel(sentAt)}
        </span>
      )
    const body = (
      <div
        data-testid="message-body"
        className="flex flex-col items-end gap-1.5"
        {...(sentAt === null ? {} : { tabIndex: 0 })}
      >
        {bodyText === '' && visible ? null : (
          <div
            ref={bubbleRef}
            data-testid="message-bubble"
            data-font-role="ui"
            className="max-w-[min(calc(var(--chat-content-width)*0.702),82%)] rounded-[12px] rounded-br-[4px] bg-(--bg-bubble) px-4 py-2 font-sans text-b2 break-words whitespace-pre-wrap text-ink"
          >
            {/* 引用标记画成内联 chip（round 14 起；round 21 换图3 观感：细描边圆角 + 图标，
                `【引用】` 前缀不进可见层）。底层消息文本不变——编辑重发仍是原文；
                0.1.3 / 006：只画**看得见的那部分**（附件追加段经核验后被扣掉，见上面的 display）。 */}
            {parseReferenceMarkers(bodyText).map((segment, index) =>
              segment.kind === 'text' ? (
                <span key={index}>{segment.text}</span>
              ) : (
                <ReferenceChip key={index} refs={segment.refs} />
              )
            )}
          </div>
        )}
        {/* 文件 / 摘选上下文：统一排在气泡**下方**（0.1.3 / 006 用户口径）；图片不在这里重复 */}
        {contextItems.length === 0 && fileParts.length === 0 ? null : (
          <div
            data-testid="message-context"
            className="flex max-w-[85%] flex-wrap justify-end gap-1.5"
          >
            {fileParts.map((part, index) => (
              <span
                key={`${part.url.slice(0, 24)}-${index}`}
                data-testid="message-file"
                className="inline-flex h-7 max-w-60 items-center gap-1.5 rounded-pill border-(length:--hairline-width) border-hairline px-2.5 text-c1 text-ink-secondary"
              >
                <Paperclip aria-hidden="true" className="size-3.5 shrink-0 text-ink-tertiary" />
                <span className="min-w-0 truncate">{part.filename ?? part.mediaType}</span>
              </span>
            ))}
            {contextItems.map((entry, index) => (
              <ContextItem key={`${entry.kind}-${entry.name}-${index}`} entry={entry} />
            ))}
          </div>
        )}
        {/* 时间与动作同一行：有动作时行高就是 32（动作钮的热区）；没有动作时用 h-0 + 下移，
            让裸文字只占用消息之间的空隙，不给每条用户消息多垫一行高度。 */}
        {sentAtNode === null && actions === null ? null : (
          <div
            data-testid="message-meta"
            className={cn(
              'relative flex items-center justify-end gap-2',
              actions === null && 'h-0 min-h-0 translate-y-2'
            )}
          >
            {sentAtNode}
            {actions}
          </div>
        )}
      </div>
    )

    return (
      <article
        data-testid={`message-${message.id}`}
        data-role="user"
        data-send-animate={sendAnimate}
        className="animate-message-in group flex flex-col items-end gap-1.5"
      >
        {draft === null ? (
          <>
            {/* 随消息发出去的图片（模块 2）：固定尺寸缩略图 + 点击放大（0.1.3 / 006 返工；
                这一行只放图片，文件 / 摘选仍在气泡下方的统一图标项里） */}
            {images.length === 0 ? null : (
              <div
                data-testid="message-files"
                className="flex max-w-[85%] flex-wrap justify-end gap-1.5"
              >
                {images.map((part, index) => (
                  <MessageImage key={`${part.url.slice(0, 24)}-${index}`} part={part} />
                ))}
              </div>
            )}
            {body}
          </>
        ) : (
          <div className="flex w-full flex-col items-end gap-2">
            <textarea
              data-testid="message-edit-input"
              aria-label="编辑消息"
              value={draft}
              autoFocus
              spellCheck={false}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault()
                  setDraft(null)
                  return
                }
                if (event.key !== 'Enter' || event.shiftKey) return
                if (event.nativeEvent.isComposing) return
                event.preventDefault()
                submitEdit()
              }}
              className="min-h-(--field-height) w-full resize-none rounded-panel border-(length:--hairline-width) border-(--border-field) bg-(--field-bg) px-3 py-2 text-b1 text-ink"
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="ghost"
                data-testid="message-edit-cancel"
                onClick={() => setDraft(null)}
              >
                取消
              </Button>
              <Button size="sm" data-testid="message-edit-save" onClick={submitEdit}>
                重新发送
              </Button>
            </div>
          </div>
        )}
        {/* 撤回的二次确认（Kimi 口径的 kyclaw 版）：这条及之后的对话会从上下文与列表里移除，
            原文回输入框；工作区里已改动的文件不在这里、也不受影响（那是工具干的事）。
            取消 = 什么都不做（`onUndo` 只在点确认时调一次）。 */}
        <Dialog
          open={undoOpen}
          onOpenChange={(open) => {
            if (!open) setUndoOpen(false)
          }}
          title="撤回这条消息？"
          description="撤销后，这条消息及之后的对话会从上下文与列表中移除，这条消息的原文会放回输入框；已改动的工作区文件不受影响。"
          footer={
            <>
              <Button
                variant="ghost"
                data-testid="message-undo-cancel"
                onClick={() => setUndoOpen(false)}
              >
                取消
              </Button>
              <Button
                variant="danger"
                data-testid="message-undo-confirm"
                onClick={() => {
                  setUndoOpen(false)
                  onUndo?.(message.id, text)
                }}
              >
                撤回
              </Button>
            </>
          }
        />
      </article>
    )
  }

  const chunks = chunkParts(message.parts, streaming)
  const lastIndex = lastRenderableIndex(message.parts)
  const text = assistantBodyText
  /**
   * 这一条自己完成的交付卡（0.1.3 / 014）：整轮汇总由 MessageList 传给轮末那条；
   * 本条自己的 parts 用来判断"卡是不是被移走了"。
   */
  const ownDeliverables = deliverablesOfMessage(message)
  /** 这一条要画的交付卡：上层整轮汇总优先；独立渲染时回落到自己 */
  const cards = deliverables ?? ownDeliverables
  /**
   * 动作行什么时候有：**流式中的那条没有**（内容还在长）。
   * 「复制」只在这条真有正文时出现（纯工具轮没有可复制的东西——不给一枚点了没反应的钮）；
   * 「重新生成」由上层给不给回调决定（只有最后一条助手消息拿到）；
   * **来源入口也算一种动作**（0.1.3 返工）：只有来源、没有复制 / 重新生成时，行照样要出现，
   * 否则入口没地方可放。
   */
  const showActions =
    !streaming && (text !== '' || onRegenerate !== undefined || sources.length > 0)
  /**
   * 014 收尾（范围刻意收窄）：只隐藏**本条确实有已完成交付、但卡已整轮汇总到轮末**、
   * 且没有别的可见内容的非轮末消息。其它空壳（空 text / step-start / 空思考 / 只有动作行）
   * 不在这里扩大删除；失败 deliver、等待审批、未知工具仍在过程流里，因此不会被误藏。
   *
   * 判据与 `chunkParts` 的实际渲染一致：**只要建出了过程块就算可见** —— 空 reasoning 也有
   * 「思考过程」入口、malformed 工具也会让 TraceBlock 显示「使用 N 个工具」；不拿"内容是否
   * 有字"当第二套口径，避免把实际会渲染的入口整体藏掉。
   */
  const hasVisibleText = chunks.some(
    (chunk) =>
      chunk.kind === 'text' &&
      (chunk.part.text.trim() !== '' || (streaming && chunk.index === lastIndex))
  )
  const hasVisibleProcess = chunks.some(
    (chunk) => chunk.kind === 'process' && chunk.entries.length > 0
  )
  if (cards.length === 0 && ownDeliverables.length > 0 && !hasVisibleText && !hasVisibleProcess) {
    return null
  }

  /** 复制正文（不含思考 / 工具 / 文件）；成功把图标转成对勾、名字转「已复制」，失败只留日志（不假装复制了） */
  const copyText = (): void => {
    void navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(true)
        if (copyTimer.current !== null) clearTimeout(copyTimer.current)
        copyTimer.current = setTimeout(() => setCopied(false), COPIED_RESET_MS)
      })
      .catch((cause: unknown) => {
        console.warn('[kyclaw] 复制消息失败', cause)
      })
  }

  /**
   * 助手正文的选文右键（0.1.3 / 013）：只有**有选区**时才接管（无选区不拦原生菜单）；
   * 菜单两项 —— 引用到输入框 / 复制。左键、Ctrl+C、表格复制 / 下载按钮都不经过这里。
   */
  const handleSelectionMenu = (event: React.MouseEvent<HTMLElement>): void => {
    if (onQuoteSelection === undefined) return
    const selected = selectionTextWithin(event.currentTarget)
    if (selected === null) return
    event.preventDefault()
    const active = document.activeElement
    menuReturnFocus.current =
      active instanceof HTMLElement && active !== document.body ? active : null
    menuAction.current = null
    restoreMenuFocus.current = false
    const items: ContextMenuItem[] = [
      {
        id: 'quote',
        label: '引用到输入框',
        icon: <TextQuote />,
        onSelect: () => {
          menuAction.current = 'quote'
          onQuoteSelection(selected)
        }
      },
      {
        id: 'copy',
        label: '复制',
        icon: <Copy />,
        onSelect: () => {
          menuAction.current = 'copy'
          const clipboard = navigator.clipboard
          if (clipboard === undefined) return
          void clipboard.writeText(selected).catch((cause: unknown) => {
            console.warn('[kyclaw] 复制选文失败', cause)
          })
        }
      }
    ]
    setSelectionMenu({ x: event.clientX, y: event.clientY, items })
  }

  // task-77：过程 entries 合并成一个过程区（思考/工具），正文独立成流式区；轮头只收过程区。
  const processEntries = chunks.flatMap((chunk) => (chunk.kind === 'process' ? chunk.entries : []))
  const textChunks = chunks.filter(
    (chunk): chunk is Extract<RenderChunk, { kind: 'text' }> => chunk.kind === 'text'
  )
  const hasTurnProcess = processEntries.length > 0
  // task-83：最终正文开始流式（过程之后已有非空文本）→ 过程完成，自动折叠；底部最新步骤收起
  const lastProcessIndex = processEntries.reduce((max, entry) => Math.max(max, entry.index), -1)
  const answerStarted = textChunks.some(
    (chunk) => chunk.index > lastProcessIndex && chunk.part.text.trim() !== ''
  )
  const processRunning = streaming && !answerStarted
  // PB-031：只有"最后一次过程之后"的正文算最终回答；工具行上方的分隔线只看它（中间正文不算）
  const hasTurnAnswer = textChunks.some(
    (chunk) => chunk.index > lastProcessIndex && chunk.part.text.trim() !== ''
  )

  return (
    <>
      <article
        ref={articleRef}
        tabIndex={-1}
        data-testid={`message-${message.id}`}
        data-role="assistant"
        data-streaming={streaming ? 'true' : undefined}
        className="animate-message-in group flex flex-col gap-2 focus:outline-none"
        onContextMenu={onQuoteSelection === undefined ? undefined : handleSelectionMenu}
      >
        {/*
          P1a · 阅读车道（章程 §9.2 Must#2 / 标志性细节）：
          AI 回复整体进叙事声部 —— 44em 行宽 + 左侧 1px 暖灰页边线 + 18px 缩进。
          `max-width` 用 prose-measure + 18px：扣掉缩进后正文行宽仍是 44em。
          lane 包住正文/思考/工具记录/交付卡；来源面板与动作行留在右侧（操作区）。
        */}
        <div
          data-testid="message-reading-lane"
          data-font-role="reading"
          className="flex w-full flex-col gap-2 pl-[var(--chat-reading-indent)]"
        >
          {hasTurnProcess ? (
            <TurnProcess
              key="turn-process"
              entries={processEntries}
              running={processRunning}
              hasAnswer={hasTurnAnswer}
              overrides={reasoningOverrides}
              reasoningOrdinals={reasoningOrdinals}
              onReasoningToggle={rememberReasoningChoice}
            />
          ) : null}
          {/* 正文独立流式区（DSH：中间区域输出该轮正文，不塞进过程块） */}
          <div data-testid="turn-answer" className="flex flex-col gap-2">
            {/* PB-031：流式中只实时显示"最后一次过程之后"的最终回答；中间轮次正文等轮末按原顺序一次全出 */}
            {textChunks
              .filter((chunk) => !streaming || chunk.index > lastProcessIndex)
              .map((chunk) => (
                <TextPart
                  key={`text-${chunk.index}`}
                  text={chunk.part.text}
                  streaming={streaming && chunk.index === lastIndex}
                  knownSources={knownSources}
                />
              ))}
          </div>
          {/* 最新步骤固定底部（仅 running 时挂载；过程区内滚不影响这条） */}
          {hasTurnProcess ? (
            <TurnLatestStatus entries={processEntries} running={processRunning} />
          ) : null}
          {/* 整轮最终交付区（0.1.3 / 014）：所有交付卡统一收在这里，不随 deliver 在 part 流里的位置走。
            流式中已经出结果的卡也当场落在这里，后续工具 / 正文不会把它挤回中间。 */}
          {cards.length === 0 ? null : (
            <div data-testid="message-deliverables" className="flex flex-col gap-2">
              {cards.map((deliverable, index) => (
                // 同路径可以是两个独立调用（多工作区同名）：key 不能只取 path
                <DeliverableCard key={`${deliverable.path}-${index}`} deliverable={deliverable} />
              ))}
            </div>
          )}
        </div>
        {/* 网页引用的来源展开列表（0.1.3 返工）：入口在动作行；列表留在消息末尾、
            交付卡之后，不在正文后面重复一枚入口。流式期间 sources 为空，整段不出现。 */}
        {sources.length === 0 ? null : (
          <SourcesPanel sources={sources} open={sourcesOpen} listId={sourcesListId} />
        )}
        {showActions ? (
          // PB-028：动作行与正文同一左基线（同一 token，几何一致；按钮仍在行内，hover 胶囊不变）
          <MessageActions className="pl-[var(--chat-reading-indent)]">
            {text === '' ? null : (
              <MessageAction
                testId="message-copy"
                label={copied ? '已复制' : '复制'}
                onClick={copyText}
              >
                {copied ? (
                  <Check aria-hidden="true" className="size-4" />
                ) : (
                  <Copy aria-hidden="true" className="size-4" />
                )}
              </MessageAction>
            )}
            {onRegenerate === undefined ? null : (
              <MessageAction testId="message-regenerate" label="重新生成" onClick={onRegenerate}>
                <RefreshCw aria-hidden="true" className="size-4" />
              </MessageAction>
            )}
            {sources.length === 0 ? null : (
              <>
                {/* 单竖线只分隔两组动作；只有来源、没有复制/重新生成时不留一条孤线 */}
                {text !== '' || onRegenerate !== undefined ? <MessageActionsDivider /> : null}
                <SourcesAction
                  sources={sources}
                  open={sourcesOpen}
                  onToggle={() => setSourcesOpen((value) => !value)}
                  listId={sourcesListId}
                />
              </>
            )}
          </MessageActions>
        ) : null}
      </article>
      {selectionMenu === null ? null : (
        <ContextMenu
          state={selectionMenu}
          onClose={closeSelectionMenu}
          autoFocus
          testId="message-selection-menu"
        />
      )}
    </>
  )
}
