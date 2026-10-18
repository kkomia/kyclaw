import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { cn } from '@renderer/components/ui/cn'
import './composer-send.css'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { fetchPluginsOverview } from '@renderer/lib/plugins-api'
import { fetchThreadContext } from '@renderer/lib/usage-api'
import { thresholdTokensOf, usagePercentOf } from '@renderer/lib/compact'
import { useProjectsStore } from '@renderer/features/projects/projects-store'
import { STARTUP_FINAL_MARK, startupMark } from '@renderer/lib/startup-timing'
import { probedKeyOf, visionOf } from '@shared/models'
import { PixelOtter } from '@renderer/features/brand/PixelOtter'
import { CHAT_MASCOT_STATE } from '@renderer/features/brand/otter-states'
import { useChatMascotState } from '@renderer/features/brand/chat-mascot-state'
import { PlusMenu, PermissionChip, ContextChip, ModelChip, PendingChips } from './ComposerControls'
import type { ComposerModeMenu, ComposerNotice } from './ComposerControls'
import { composeOutgoing, prepareAttachment } from './composer-attachments'
import type { OutgoingMessage, PdfExtractor, PendingAttachment } from './composer-attachments'
import {
  resolveContextItem,
  subscribeContextItems,
  subscribeDrafts,
  utf8ByteLength
} from './composer-inbox'
import type { ComposerQuoteDraft } from './composer-inbox'
import {
  discardComposerCarryover,
  keepComposerCarryover,
  takeComposerCarryover
} from './composer-carryover'
import { ComposerSuggest } from './ComposerSuggest'
import {
  caretPlacementFromRects,
  caretRectAtOffset,
  motionDurationMs,
  shouldShowComposerCaret
} from './composer-caret'
import { ReferenceChipInner } from './reference-chip'
import {
  detectTrigger,
  fileRows,
  flattenGroups,
  slashGroups,
  type SuggestionGroup,
  type SuggestionRow,
  type SuggestionTriggerKind
} from './suggestion-model'
import {
  insertReferenceMarker,
  parseReferenceMarkers,
  replaceRangeWithMarker,
  type ReferenceKind
} from './reference-markers'
import { folderNameOf, sessionRootPathOf, sessionWorkspaceOf } from './session-workspace'
import { useEffectiveMotion } from '@renderer/lib/motion'
import { rememberComposerRect } from './send-flight'

/**
 * 输入卡（UI 参考 §4.6 实测）：宽 max 768、圆角 24（--chat-input-radius）；
 * 结构 = （附件/引用 chip 行）+ 输入区（自适应，最小 --composer-input-min-height（常态 56）/
 * 最大 170，超出内部滚动；round 64 起初始页再高一档，见 ComposerProps.hero）+ 底部工具条（48）：
 * 左起 ＋菜单（添加文件/引用技能/引用插件/引用上下文/**模式分组**——round 81 起「进入规划模式」
 * 与「任务清单」也收在这里）、权限 chip（两档 ask|full，当前会话工作区；**判不出工作区时入口
 * 也照旧在**——同一枚下拉里说明原因并指路去设置，用户实报过"权限模式选择按钮不见了"）；
 * 右端（round 42 二轮起）**上下文环**（独立组件 ContextChip）+ 模型 chip
 * （T8 已配置 provider 的默认项；round 8 按用户实拍从左侧组移到右侧、发送钮之前）+ 发送/停止。
 * round 57：用量 ≥ 80% 时 ContextChip 会在环**左边**多渲染一枚「压缩上下文」胶囊（点即压缩）。
 *
 * 高度按 Kimi 实况页（a84af355 截图：单行输入 + 一行工具条），默认单行时紧凑，
 * 不再固定三段 "40 + 111 + 49" —— 那是首屏形态，常态下多出来的空白正是用户点名的"过高"。
 * round 64 回调（用户又实拍"默认输入框高度偏低"）：常态最小高 48 → 56，初始页整档到 72 ——
 * 两档都是语义 token，不是散落的 px。
 * round 66（用户又实拍）：卡片里**不嵌**任何能力 chip 行了 ——「选择项目」在卡片**上方**单独一行、
 * PPT 在卡片下方单独一行，两行都在对话页（ChatPage 的页脚）挂，卡片结构回到纯输入件。
 * 字号/提示不做小字说明（雷点 2）：键盘行为靠肌肉记忆与按钮语义，不写提示行；
 * 附件/引用的内容（名字/大小）是数据，不是解释性小字。
 *
 * 附件（round 7 起；模块 2 扩三类；round 53 第三类改走路径引用）：**图片**在当前模型 vision=true 时
 * 随消息真发（vision=false 人话拒收，不假装收下）；**PDF** 统一由主进程抽文字层再内联（扫描件给人话）；
 * **其余文件**（exe、10MB 大文件、小文本都一样）不再读内容 —— 载荷 = `【附件】<路径>`（会话根内相对、
 * 根外绝对，路径来自 preload 的 webUtils 桥；拿不到路径才兜底旧的 ≤16KB 文本内联）。
 * 拖拽、＋ 上传与**粘贴**（round 50：截图工具贴的图 / 资源管理器贴的文件）走同一个 pickFiles ——
 * 几条入口的行为必须是同一套。口径见 composer-attachments.ts 头注。
 * 图片在附件条上是**磁贴**（round 50，PendingImageTile：hover 删除/@ 提及、点空白放大预览）；
 * @ 提及只往输入里插一段可 chip 化的引用文字（`【引用】图片：图N`），本体照样随消息真发。
 *
 * 另一条入口（round 42）：工作台文件树的「添加到上下文」与预览区选中的「添加到上下文（摘选）」
 * 走 composer-inbox 的事件通道进来，落进**同一个附件条**、同一套上限（解析在订阅方做）。
 * round 61：同一个通道里多了「原文放回输入框」（消息动作行的「撤回」→ 草稿），草稿只有这一条外部写入口。
 * 0.1.3 / 013 返工：选中 AI 回复的「引用」也走这条通道，但落点是**附件条**（可展开 / 编辑的原文卡），
 * 不写输入框；发送时仍带完整原文（不是卡上那行摘要）。
 *
 * 引用（round 14 起=光标处内联标记；round 21 换图3 观感：不透明覆盖层画 chip）：`＋ → 引用…`
 * 与 round 15 的建议浮窗同一条路 ——
 * 键入 `@`（词边界）浮出工作区文件、键入 `/` 浮出插件/技能（见 suggestion-model.ts 与
 * ComposerSuggest.tsx），选中都把触发段替换成 `【引用】<kind>：<label>` 标记。
 *
 * 交互：Enter 发送 / Shift+Enter 换行（输入法合成中不拦截；**浮窗打开时** ↑/↓ 走条目、Enter 选中、
 * Esc 关浮窗）；流式中发送钮变停止（stop()）；流式中按下发送不丢内容 —— 交给上层排队
 * （round 62 起队列按会话挂在 sessions-store 上，切会话也不丢，见 ChatPage 的 submit / flushNext）。
 *
 * round 76：输入卡现在**从这一屏第一帧就挂着**（不再等端点/会话列表/历史回灌），所以多了一档
 * "会话实例还没就绪"的 `pending`：那一段发送挡住（按钮禁用 + 回车不发 + 工具条一行状态文字），
 * 输入框本身照常能聚焦、能打字、能加附件（那些都是本地的事）。会话 id 到位那一下这一挂会重挂
 * 一次，草稿/附件/焦点由 composer-carryover 过桥带走（见下面的落位 effect）。
 */
export interface ComposerProps {
  /** 当前会话 id（权限 chip 判"会话的工作区根"用；判不出时入口照旧在，下拉里说明原因并指路去设置） */
  threadId?: string | null
  /** 流式中（submitted / streaming）：发送钮切换为停止 */
  busy?: boolean
  /** 已排队的条数（流式中发送的消息），0 时不显示 */
  queuedCount?: number
  onSend: (message: OutgoingMessage) => void
  onStop: () => void
  /** round 19：「/」→「压缩上下文」被选中（立即压缩；进行中/不可用时命令行为禁用态） */
  onCompact?: () => void
  /** 压缩进行中（命令行 hint 显示「压缩中…」并禁用） */
  compactBusy?: boolean
  /** 压缩不可用（流式 / 等审批）：命令行可见但不可点 */
  compactDisabled?: boolean
  /**
   * 压缩的**操作反馈** notice（由上层给：失败 / 没有可压缩的旧消息）；与附件等内部 notice 合并显示。
   * round 59：压缩成功与进行中不再是输入框的事（对话流里的分界线说），这里只留给失败反馈。
   */
  externalNotice?: ComposerNotice | null
  /**
   * round 57：上下文用量的**取数刷新信号**（上层每轮结束 +1）——透给上下文环那侧的
   * 「压缩上下文」胶囊，让它在用量越过出现线时及时露面（环自己也跟着变新）。
   */
  usageVersion?: number
  /**
   * round 64：**初始页（空会话）**——输入区给高一档的默认最小高（`--composer-input-min-height-hero`）。
   *
   * 用户实拍两条：①"默认对话输入框高度偏低，可以调整高一点" → 常态最小高从 48 提到 56；
   * ②"空态尤其明显" → 初始页再高一档（72）：那一屏没有消息，输入框就是这一屏的主角，
   * 高一点的盒子更像"可以往里写"的目标。两条都走语义 token（不写 px 魔法数字），
   * 高度切换走 --motion-main 过渡（首条消息发出时不硬切）。
   */
  hero?: boolean
  /**
   * round 76：**会话实例还没就绪**时的那一档（`null` / 缺省 = 就绪）。
   *
   * 为什么要有：输入卡现在从这一屏的第一帧就在（不再等端点 / 会话列表 / 历史回灌），
   * 但那一段时间里"发出去"是没有去处的 —— 所以**发送一律挡住**（按钮禁用、回车也不发），
   * 并在工具条那一行露一句状态（`label`，如"正在连接…" / "正在载入会话…"），
   * 位置就在发送钮左边（与既有的"已排队 N 条"同一格）——看得见、对得上指的是哪个动作。
   *
   * 出错那一档 `label` 是 null：错误卡已经在消息区把原因与重试说清楚了，这里不重复解释
   * （雷点 2：不用小字解释后端），但**挡发仍然生效**。
   */
  pending?: { label: string | null } | null
  /**
   * round 81：**模式分组**（「进入规划模式」+「任务清单」）—— 常驻在工具条上的两颗模式按钮
   * 收进左下角这一个 ＋ 菜单里（用户口径：绝不另造第二个模式菜单）；权限 chip 仍在工具条上。
   * 由上层按真实状态给：未就绪时给 null（那一挂没有可动的对象），正在运行时条目禁用。
   *
   * round 85：`/` 命令浮窗里的「进入规划模式」用的也是这一份（选中调 `mode.plan.onSelect`）——
   * 两条入口背后是同一个 `enterPlan`，不是第二套实现。
   */
  mode?: ComposerModeMenu | null
  /**
   * R92：**草稿过桥放行位**（默认 true = 既有口径，直接使用 Composer 的测试不受影响）。
   *
   * 只有"同一次初始化落位"的重挂该接上一挂的草稿（冷启动里用户提前敲的字不白敲）；
   * 不放行时把上一挂可能留下的残留**一并丢掉**——用户主动换会话 / 新建 / 删除 触发的重挂
   * 不许把草稿带过去（见 composer-carryover 的边界说明）。ChatPage 按
   * "activeId 从无到有、且这次变更不是用户点出来的"判定它（见那边的 `carryoverAllowed`）。
   */
  allowCarryover?: boolean
}

let uidCounter = 0
function uid(): string {
  uidCounter += 1
  return `c${uidCounter}-${Math.random().toString(36).slice(2, 7)}`
}

/** 回复选段在附件条上的名字（多条选段各是一张卡；来源消息 id 走 tooltip / metadata） */
const REPLY_QUOTE_NAME = '回复选段'

/**
 * 0.1.3 / 013 返工：把「选中 AI 回复」的原文做成一条**草稿附件**。
 * 原文只做换行归一（不 trim 掉用户选中的内容），摘要卡只负责展示；发送时仍是全文。
 * 来源消息 id 放进 `originRef`（气泡下方图标项的 tooltip / metadata source），可追溯。
 */
function replyQuoteAttachment(quote: ComposerQuoteDraft, text: string): PendingAttachment {
  return {
    id: uid(),
    name: REPLY_QUOTE_NAME,
    size: utf8ByteLength(text),
    text,
    quote: true,
    quoteFrom: 'reply',
    origin: 'AI 回复',
    ...(quote.messageId === undefined ? {} : { originRef: `AI 回复（消息 ${quote.messageId}）` })
  }
}

/**
 * 剪贴板里的文件（round 50 粘贴入口）。
 *
 * **`files` 是唯一来源**，只有它是空的时候才回退去读 `items`（kind === 'file'）。
 * round 85 修的就是这里：原先两处都读、靠"名字+大小+类型+lastModified"当指纹去重 —— 而这两条路
 * 在真机上给的**不是同一个 File 对象**（Chromium 各自构造一份，元数据不保证逐字相等；截图工具贴图
 * 时 lastModified 就对不上），指纹一漏，同一次粘贴就被入队两份（用户实报 011：同一张图被粘两次，
 * 得手动删掉多出来的一份）。`files` 本来就是这次粘贴的完整文件清单，再读一遍 items 只会制造重复；
 * items 回退路上仍按指纹去重（有些平台/来源只填 items，同一份也可能出现两次）。
 * 一个文件都没有 = 纯文本粘贴：调用方**不拦截**，保持默认行为。
 */
function clipboardFilesOf(data: DataTransfer | null): File[] {
  if (data === null) return []
  const files: File[] = Array.from(data.files ?? [])
  if (files.length > 0) return files
  const keyOf = (file: File): string =>
    `${file.name}\u0000${file.size}\u0000${file.type}\u0000${file.lastModified}`
  const seen = new Set<string>()
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== 'file') continue
    const file = item.getAsFile()
    if (file === null) continue
    const key = keyOf(file)
    if (seen.has(key)) continue
    seen.add(key)
    files.push(file)
  }
  return files
}

export function Composer({
  threadId = null,
  busy = false,
  queuedCount = 0,
  onSend,
  onStop,
  onCompact,
  compactBusy = false,
  compactDisabled = false,
  externalNotice = null,
  usageVersion = 0,
  hero = false,
  pending = null,
  mode = null,
  allowCarryover = true
}: ComposerProps): React.JSX.Element {
  /** 实例没就绪（round 76）：发送挡住 + 工具条那一行露状态（label 可能是 null，见 ComposerProps） */
  const blocked = pending !== null
  const [draft, setDraft] = useState('')
  /**
   * R92：草稿的**最后写入记录**与**最后一次 commit 的草稿**。
   *
   * 为什么需要（v4 取证，2026-10-16）：冷启动"落位换 key 重挂"若与输入落在**同一批提交**，
   * 这一挂的 `draft` 更新会随组件一起被 React 丢掉，受控恢复又把输入框按旧 state 写回 ——
   * 卸载过桥只抄 DOM 就会把用户刚敲的字吞掉（e2e 间歇 8s/30s 超时的实测形状：
   * keep 时 dom/state 双双是空）。所以：**每一次写入都同步记进 `draftTruthRef`**
   * （键与程序化都算，和写入同拍、不等 commit）；卸载过桥时"DOM 等于上一次 commit 的草稿
   * （= 被回写的产物）、或节点已经不在了"就改以它为准（见 keep 处的判据）。
   */
  const draftTruthRef = useRef('')
  const draftPropRef = useRef('')
  useEffect(() => {
    draftPropRef.current = draft
  }, [draft])
  /** 草稿的唯一写入口：先记真值、再落 state（`draftTruthRef` 因此永远不比输入慢） */
  const trackDraft = (value: string): void => {
    draftTruthRef.current = value
    setDraft(value)
  }
  const [attachments, setAttachments] = useState<PendingAttachment[]>([])
  /** 附件的实时值（与草稿 ref 同一类用途：重挂前过桥带走，见 composer-carryover） */
  const attachmentsRef = useRef(attachments)
  useEffect(() => {
    attachmentsRef.current = attachments
  }, [attachments])
  const [notice, setNotice] = useState<ComposerNotice | null>(null)
  /** 拖拽悬停中（只做视觉提示；收不收还是 pickFiles 说了算） */
  const [dragging, setDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  /**
   * 输入框**最近一次挂上来的那个 DOM 节点**（卸载过桥要读它，见 composer-carryover）。
   *
   * 为什么不直接读 `textareaRef`：React 在**卸载的 mutation 阶段**就把 ref 置空了，而卸载的
   * effect cleanup（过桥那一手）跑在**后面的 passive 阶段** —— 那时 `textareaRef.current` 已经是
   * null，"输入框现在写着什么"就读不到。所以用回调 ref 另存一份节点（置空那一下不跟着清），
   * 过桥时从这一份读 DOM 的真值。
   */
  const lastTextareaRef = useRef<HTMLTextAreaElement | null>(null)
  const attachTextarea = useCallback((node: HTMLTextAreaElement | null): void => {
    textareaRef.current = node
    if (node !== null) lastTextareaRef.current = node
  }, [])
  /** 引用覆盖层（chip 的盖层）：与 textarea 同排版，随内容滚动（round 21 起在 textarea 之上） */
  const mirrorRef = useRef<HTMLDivElement>(null)
  /**
   * 插入标记后待落的光标位（渲染完再设 selection，避免用旧值越界）。
   * round 62：从 ref 换成 state —— 原来那个落位 effect **没有依赖数组**（每次渲染都跑一遍、
   * `pendingCaret.current` 非空就抢 focus），这里改成"值变了才落位"的显式信号：行为不变
   * （渲染后落位一次），但不再每次渲染都去摸 DOM。null = 没有待办。
   */
  const [caretToken, setCaretToken] = useState<number | null>(null)

  /**
   * P1b 配方 3：Composer 自绘 caret（textarea 原生 caret 隐藏；镜像层测位置）。
   * IME 安全：composition 期间不画、回原生 caret；含引用 chip 时镜像文字偏移与原始串
   * 不再一一对应，也回原生 caret（不猜位置）。
   */
  const [composerFocused, setComposerFocused] = useState(false)
  const [composing, setComposing] = useState(false)
  const [typing, setTyping] = useState(false)
  const typingTimerRef = useRef<number | null>(null)
  const [caretPlacement, setCaretPlacement] = useState({
    left: 0,
    top: 12,
    height: 22,
    visible: false
  })
  const hasReferenceMarkers = useMemo(
    () => parseReferenceMarkers(draft).some((segment) => segment.kind !== 'text'),
    [draft]
  )
  const motion = useEffectiveMotion()
  const caretCustom =
    motion.caret === 'typing' &&
    shouldShowComposerCaret({
      focused: composerFocused,
      composing,
      hasReferenceMarkers
    })

  const syncComposerCaret = useCallback((): void => {
    const textarea = textareaRef.current
    const mirror = mirrorRef.current?.firstElementChild
    if (
      !caretCustom ||
      textarea === null ||
      mirror === null ||
      mirror === undefined ||
      typeof document.createRange !== 'function'
    ) {
      setCaretPlacement((current) => (current.visible ? { ...current, visible: false } : current))
      return
    }
    const rect = caretRectAtOffset(mirror, textarea.selectionStart ?? 0)
    if (rect === null) {
      setCaretPlacement((current) => (current.visible ? { ...current, visible: false } : current))
      return
    }
    const lineHeight = Number.parseFloat(getComputedStyle(textarea).lineHeight)
    const placement = caretPlacementFromRects(
      {
        left: rect.left,
        top: rect.top,
        height: Number.isFinite(lineHeight) ? lineHeight : rect.height
      },
      textarea.getBoundingClientRect(),
      textarea.scrollTop
    )
    setCaretPlacement({ ...placement, visible: true })
  }, [caretCustom])

  useEffect(() => {
    if (!caretCustom) return
    const frame = requestAnimationFrame(() => syncComposerCaret())
    return () => cancelAnimationFrame(frame)
  }, [caretCustom, draft, syncComposerCaret])

  useEffect(
    () => () => {
      if (typingTimerRef.current !== null) window.clearTimeout(typingTimerRef.current)
    },
    []
  )

  const settings = useSettingsStore((state) => state.settings)
  /**
   * 状态海獭（task-62，用户：「把海獭 logo 移动到对话输入框右上角而不是最右上角」）：
   * 从 ChatHeader 移到输入卡右上角（见 return 的 `composer-otter`）；状态来源仍 `useChatMascotState`
   * （idle/think/type，结束 1.2s 回 idle）。实例未就绪（threadId=null）时传空串给 hook（恒 idle）
   * 且不渲染 —— 初始页（hero）也不渲染：一屏一只，hero 只有报头 lockup 那只。
   * reduced（用户「减弱」/系统减弱/「总是」）由 useEffectiveMotion 折算 → `paused` 静态帧。
   */
  const mascotState = useChatMascotState(threadId ?? '')
  const showOtter = threadId !== null && !hero
  // **响应式订阅 mappings**，不要只选 store 上的 projectOf 函数：函数引用恒定，mappings 变了
  // （「移至项目」/ 映射快照迟到）组件不重渲染 → 会话根停在旧值。口径与工作台
  // use-workbench-root.ts 同一套（那边是用户实报的同一类缺陷）。
  const mappings = useProjectsStore((state) => state.mappings)
  const projectOf = useCallback(
    (id: string | null): string | null => (id === null ? null : (mappings[id] ?? null)),
    [mappings]
  )
  // 两条口径各管各的（round 55，见 session-workspace.ts 头注）：rootWorkspace 是**授权列表里的
  // 那条条目**（权限 chip 切的是它的 mode）；rootPath 是**真根**（无项目会话 = 默认工作区下的会话
  // 子目录），决定附件的"根内 → 相对路径"。
  const rootWorkspace = sessionWorkspaceOf({ threadId, settings, projectOf })
  const rootPath = sessionRootPathOf({ threadId, settings, projectOf })
  const contextLabel = rootWorkspace === null ? null : folderNameOf(rootWorkspace.path)
  /**
   * 判不出工作区时，权限下拉里那句原因（说清"为什么现在切不了 + 去哪儿"，对得上设置页里
   * 真能看到的两种状态）。判得出时用不到它。
   */
  const permissionReason =
    settings.workspaces.length === 0
      ? '还没有授权工作区：先去设置里添加一个'
      : '会话的工作区还没定下来：去设置里指认默认工作区，或给这条会话选一个项目'
  const enabledPlugins = settings.mcpServers
    .filter((server) => server.enabled)
    .map((server) => ({ id: server.id, name: server.name }))
  /**
   * 当前模型能不能看图（模块 2）：**探测结论 > 注册表 > false**（口径见 shared/models 的 visionOf；
   * 结论来自注册/保存后主进程那条真带图的探测，没有手动开关）。
   * 图片的收/拒在这一层定，UI 上不给解释性小字——拒的时候由 pickFiles 给一句人话。
   */
  const currentProvider =
    settings.providers.find((provider) => provider.isDefault) ?? settings.providers[0]
  const vision = visionOf(
    currentProvider?.model,
    currentProvider === undefined
      ? undefined
      : settings.probedModels[probedKeyOf(currentProvider.id, currentProvider.model)]
  )

  /** 「引用技能」菜单的数据（round 13：插件装进来的技能；挂载 + 每次打开菜单时拉一遍） */
  const [installedSkills, setInstalledSkills] = useState<
    ReadonlyArray<{ dir: string; name: string }>
  >([])
  const refreshSkills = useCallback((): void => {
    void fetchPluginsOverview().then(
      (overview) =>
        setInstalledSkills(
          overview.installedSkills.map((skill) => ({ dir: skill.dir, name: skill.name }))
        ),
      () => {
        // 插件通道不可用（浏览器 / 单测未装桥）：菜单退化为空态，不打扰输入
      }
    )
  }, [])
  useEffect(() => {
    refreshSkills()
  }, [refreshSkills])

  // round 73：冷启动打点 —— 输入框已经挂到 DOM 上（"能打字了"就是这一笔；链的终点）
  useEffect(() => {
    startupMark(STARTUP_FINAL_MARK)
  }, [])

  /**
   * 建议浮窗（round 15）：`@` 文件 / `/` 插件·技能。`suggest` = 当前触发（含要替换的区间）；
   * 文件清单按 threadId 缓存一次（换会话重拉），取不到就把人话显示在浮窗里。
   */
  const [suggest, setSuggest] = useState<{
    kind: SuggestionTriggerKind
    start: number
    end: number
    query: string
  } | null>(null)
  const [activeSuggestion, setActiveSuggestion] = useState(0)
  const [files, setFiles] = useState<{ threadId: string; list: readonly string[] } | null>(null)
  const [filesError, setFilesError] = useState<string | undefined>(undefined)
  /** round 19：「压缩上下文」命令行显示的使用率（打开 / 浮窗时取一次；取不到 = 不显示） */
  const [usagePercent, setUsagePercent] = useState<number | null>(null)

  const refreshTrigger = (value: string, caret: number | null): void => {
    const trigger = detectTrigger(value, caret ?? value.length)
    if (trigger === null) {
      setSuggest(null)
      return
    }
    setSuggest({
      kind: trigger.kind,
      start: trigger.start,
      end: caret ?? value.length,
      query: trigger.query
    })
    setActiveSuggestion(0)
  }

  const suggestOpen = suggest !== null
  const fileReady = files !== null && files.threadId === threadId
  // 通道缺失是"环境事实"，在渲染期判定（不在 effect 里 setState——避免级联渲染）
  const workspaceApi = window.kyclaw?.workspace
  const fileNotice =
    threadId === null
      ? '当前没有会话：开始对话后用 @ 引用文件'
      : workspaceApi === undefined
        ? '工作区通道不可用（window.kyclaw 缺失）'
        : filesError
  const suggestionGroups: SuggestionGroup[] =
    suggest === null
      ? []
      : suggest.kind === 'file'
        ? [{ title: '', rows: fileRows(fileReady ? files.list : [], suggest.query) }]
        : slashGroups(
            {
              plugins: enabledPlugins,
              skills: installedSkills,
              command: { percent: usagePercent, busy: compactBusy, disabled: compactDisabled },
              // round 85：`/` 里那条「进入规划模式」与 ＋ 菜单同源 —— 只有真的能进（普通模式、
              // 实例就绪）时才给这条；正在跑 / 等审批 / 压缩中给 disabled（可见、按不动）
              plan:
                mode === null || mode.plan === null
                  ? undefined
                  : { disabled: mode.plan.disabled === true }
            },
            suggest.query
          )
  const suggestionRows = flattenGroups(suggestionGroups)
  const activeIndex =
    suggestionRows.length === 0 ? 0 : Math.min(activeSuggestion, suggestionRows.length - 1)
  const activeRow: SuggestionRow | null = suggestionRows[activeIndex] ?? null

  /** 打开 `@` 时拉一次文件清单（按会话缓存；换会话会重拉） */
  useEffect(() => {
    if (suggest?.kind !== 'file' || threadId === null) return
    if (files !== null && files.threadId === threadId) return
    if (workspaceApi === undefined) return // 渲染期的 fileNotice 已说明
    let alive = true
    void workspaceApi.listFiles(threadId).then(
      (result) => {
        if (!alive) return
        setFiles({ threadId, list: result.files })
        setFilesError(undefined)
      },
      (error: unknown) => {
        if (alive) setFilesError(error instanceof Error ? error.message : String(error))
      }
    )
    return () => {
      alive = false
    }
  }, [suggest?.kind, threadId, files, workspaceApi])

  /**
   * round 62：命令行那条使用率的**阈值**（依赖面收窄到 providers / modelPrefs / probedModels /
   * modelOverrides，见 lib/compact 的 ThresholdSettings）。原来下面那个 effect 直接依赖整个 `settings`：
   * 权限规则、工作区、视觉探测结论……任何一处变更，只要 `/` 浮窗还开着就白拉一次用量。
   */
  const thresholdTokens = useMemo(
    () =>
      thresholdTokensOf({
        providers: settings.providers,
        modelPrefs: settings.modelPrefs,
        probedModels: settings.probedModels,
        modelOverrides: settings.modelOverrides
      }),
    [settings.providers, settings.modelPrefs, settings.probedModels, settings.modelOverrides]
  )

  /** 打开 `/` 时取一次使用率（命令行「压缩上下文」的次要位是数值展示，不是解释小字） */
  useEffect(() => {
    if (suggest?.kind !== 'slash' || threadId === null || threadId === '') return
    let alive = true
    void fetchThreadContext(threadId).then(
      (context) => {
        if (alive) setUsagePercent(usagePercentOf(context.lastInput, thresholdTokens))
      },
      () => {
        // 取不到（服务没起来 / 单测未装桥）：不显示数值，命令照常可用
        if (alive) setUsagePercent(null)
      }
    )
    return () => {
      alive = false
    }
  }, [suggest?.kind, threadId, thresholdTokens])

  /** 选中一条建议：命令行走"立即执行"（移除触发段）；引用行把触发段换成引用标记 */
  const pickSuggestion = (row: SuggestionRow): void => {
    if (suggest === null || row.disabled === true) return
    if (row.command !== undefined) {
      // 命令行：不插引用标记 —— 触发词整段移除后立即执行
      const remaining = draft.slice(0, suggest.start) + draft.slice(suggest.end)
      setCaretToken(suggest.start)
      trackDraft(remaining)
      setSuggest(null)
      if (row.command === 'compact') onCompact?.()
      // round 85：`/进入规划模式` 与 ＋ 菜单那条是**同一个实现**（mode.plan.onSelect = enterPlan）
      else mode?.plan?.onSelect()
      return
    }
    if (row.reference === undefined) return
    const inserted = replaceRangeWithMarker(
      draft,
      suggest.start,
      suggest.end,
      row.reference.kind,
      row.reference.label
    )
    setCaretToken(inserted.caret)
    trackDraft(inserted.text)
    setSuggest(null)
  }

  const canSend = draft.trim() !== '' || attachments.length > 0
  /**
   * round 76：能真的发出去 = 有内容 **且** 会话实例就绪。
   * 挡板只作用于"发送"这一个动作：输入框照常能聚焦、能打字、能加附件（那些都是本地的事），
   * 禁用态与工具条那一行的状态文字就是给用户的反馈，不会出现"看着能发、按了没反应"。
   */
  const sendable = canSend && !blocked
  /** 内部 notice（附件/权限）优先；没有时显示上层给的压缩结果 notice（round 19） */
  const shownNotice = notice ?? externalNotice

  /** round 21：× 删掉一段引用 chip（按段的 [start, start+raw.length) 精确替换；光标落在段起点） */
  const removeReferenceSegment = (segment: { start: number; raw: string }): void => {
    const start = Math.max(0, Math.min(segment.start, draft.length))
    const end = Math.min(draft.length, start + segment.raw.length)
    setCaretToken(start)
    trackDraft(draft.slice(0, start) + draft.slice(end))
  }

  const submit = (): void => {
    // round 76：实例没就绪就不发（草稿一个字都不动 —— 就绪之后接着发）
    if (!sendable) return
    // 动效 B：记下输入卡的真实位置，新消息的 flight 从它飞到气泡目标位
    const card = document.querySelector<HTMLElement>('[data-testid="composer"]')
    rememberComposerRect(card?.getBoundingClientRect() ?? null)
    onSend(composeOutgoing({ text: draft, attachments }))
    trackDraft('')
    setAttachments([])
    setNotice(null)
  }

  /**
   * 「＋ → 引用…」：在**光标处**插入标记文本（round 14 用户口径："不要单独取顶格，
   * 会失去在输入文本中的位置；一次可能引用多个，是有指向性的"）。插入后光标落在标记后面、
   * 焦点留在输入框；本来就在输入框里选中的一段文本不会被顶掉（在光标处展开）。
   */
  const addReference = (reference: { kind: ReferenceKind; label: string }): void => {
    const textarea = textareaRef.current
    const caret = textarea?.selectionStart ?? draft.length
    const inserted = insertReferenceMarker(draft, caret, reference.kind, reference.label)
    setCaretToken(inserted.caret)
    trackDraft(inserted.text)
  }

  /**
   * 插入标记后的光标落位（round 62：带依赖的 effect —— 只有 `caretToken` 变了才跑一次，
   * 落完位就把它清回 null；渲染后落位一次的既有行为不变）。
   */
  useEffect(() => {
    if (caretToken === null) return
    const textarea = textareaRef.current
    if (textarea === null) return
    textarea.focus()
    textarea.setSelectionRange(caretToken, caretToken)
    setCaretToken(null)
  }, [caretToken])

  /** 主进程的 PDF 抽取（通道缺失=浏览器/单测环境：回一句人话，不抛） */
  const extractPdf = useCallback<PdfExtractor>(async (bytes) => {
    const api = window.kyclaw?.attachments
    if (api === undefined) return { ok: false, message: '附件通道不可用（window.kyclaw 缺失）' }
    return api.extractPdf(bytes)
  }, [])

  /**
   * 收下一批文件（＋ 上传、拖拽与粘贴共用这一条路）：逐个试收，收下的进附件条、
   * 没收的攒成一句话（档位与原因见 composer-attachments.ts）。
   *
   * round 53：非图片非 PDF 的文件走**路径引用**——路径从 preload 的
   * `files.pathForFile`（webUtils）取；会话根内转相对路径、根外留绝对路径。
   * 这里的"会话根"是**真根**（`sessionRootPathOf`；无项目会话 = 默认工作区下的会话子目录）——
   * 用权限 chip 那条授权条目当基准的话，子目录里的文件会被误判成"根外"、发成绝对路径。
   * 桥缺失 / 拿不到路径时 prepareAttachment 自己兜底旧行为（≤16KB 文本内联，否则旧拒收文案）。
   */
  const pickFiles = async (files: File[]): Promise<void> => {
    const rejected: string[] = []
    const accepted: PendingAttachment[] = []
    // 通道缺失（浏览器 / 单测未装桥）不在这里报错：拿不到路径就走旧兜底，流程不断
    const pathForFile = window.kyclaw?.files?.pathForFile
    for (const file of files) {
      const result = await prepareAttachment(file, {
        vision,
        extractPdf,
        id: uid(),
        rootPath,
        pathForFile
      })
      if ('problem' in result) rejected.push(`${file.name}（${result.problem}）`)
      else accepted.push(result.attachment)
    }
    if (accepted.length > 0) setAttachments((previous) => [...previous, ...accepted])
    setNotice(
      rejected.length > 0 ? { tone: 'warning', text: `未附加：${rejected.join('、')}` } : null
    )
  }

  /**
   * round 42：「添加到上下文」（文件树右键 / 预览选中）→ 附件条。
   * 事件只说"哪个会话的哪个文件"，读文件与判档在这里做（口径仍是 composer-attachments 那套，
   * 见 composer-inbox.ts）；别的会话的事件、自己没有会话时的事件都丢掉——不猜、不错挂。
   *
   * round 62：**订阅不依赖 `vision`** —— 视觉探测结论回来会改 vision，原来那会让这条订阅重挂
   * （cleanup → 重新 subscribe），而通道是**同步派发、没有缓冲**（composer-inbox）：那次重挂的
   * 窗口里发布的事件两头都不在，事件直接丢。改成 ref 现读最新值：订阅只跟会话走，判档永远用
   * 当前结论（ref 在下面的小 effect 里跟着 vision 更新）。
   */
  const visionRef = useRef(vision)
  useEffect(() => {
    visionRef.current = vision
  }, [vision])

  useEffect(() => {
    if (threadId === null) return
    // 换会话 / 卸载时把这条订阅收掉：晚到的解析结果不再往新会话的附件条上挂（与 listFiles 同一套 alive 口径）
    let alive = true
    const unsubscribe = subscribeContextItems((item) => {
      if (item.threadId !== threadId) return
      void resolveContextItem(item, {
        channel: window.kyclaw?.workbench ?? null,
        vision: visionRef.current,
        extractPdf,
        id: uid()
      }).then((result) => {
        if (!alive) return
        if ('problem' in result) {
          setNotice({ tone: 'warning', text: `未附加：${item.name}（${result.problem}）` })
          return
        }
        setAttachments((previous) => [...previous, result.attachment])
        setNotice(result.note === undefined ? null : { tone: 'warning', text: result.note })
      })
    })
    return () => {
      alive = false
      unsubscribe()
    }
  }, [threadId, extractPdf])

  /**
   * round 61：「撤回」确认后把原文放回输入框（对话页 → 输入卡，见 composer-inbox 的草稿通道）。
   * 只收本会话的事件；落草稿的同时把光标交回输入框末尾 —— 复用「渲染后落位」那套，
   * 顺带把焦点从刚关掉的确认弹窗手里拿回来（那一下的落位在弹窗卸载之后，见上面的落位 effect）。
   *
   * round 76：同一条通道上还有「能力入口」胶囊，它要 `mode: 'append'` —— 空框照旧直接填入，
   * 已经有草稿就**追加到末尾**（用户已经写下的那半句一个字不丢；只有空白也算空框）。
   * 缺省（撤回那一路）仍是整段替换：那条路是"把这条消息收回来重发"，语义上就该覆盖。
   *
   * 追加读 `draftTruthRef`（同步真值），不读 passive effect 才更新的 state 镜像：
   * 同一 tick 连续两次 append 时，第二次必须看见第一次的结果，不能把第一次覆盖掉。
   *
   * 0.1.3 / 013 返工：`draft.quote` 走**附件条**（不写输入框）：原文收成一张可展开 / 可编辑的
   * 摘要卡，已有草稿与已有附件都保留（追加，不覆盖）；只落本地状态，不触发发送。
   */
  useEffect(() => {
    if (threadId === null) return
    return subscribeDrafts((draft) => {
      if (draft.threadId !== threadId) return
      if (draft.quote !== undefined) {
        const quote = draft.quote
        // 换行符归一，但**不 trim 正文**：用户选中的原文一个字节都不丢
        const text = quote.text.replace(/\r\n?/g, '\n')
        if (text.trim() === '') return
        setAttachments((previous) => [...previous, replyQuoteAttachment(quote, text)])
        // 焦点交回输入框末尾，用户可以直接写批注；输入框内容与光标位置之外的东西都不动
        setCaretToken(draftTruthRef.current.length)
        return
      }
      if (draft.text === undefined) return
      const current = draftTruthRef.current
      if (draft.mode === 'append' && current.trim() !== '') {
        const next = `${current}${current.endsWith('\n') ? '' : '\n'}${draft.text}`
        trackDraft(next)
        setCaretToken(next.length)
        return
      }
      trackDraft(draft.text)
      setCaretToken(draft.text.length)
    })
  }, [threadId])

  /**
   * round 76：会话实例就绪那一下，ChatPage 会**换 key 重挂**这一挂（"换会话 = 换一挂"的既有口径），
   * 输入卡的草稿/附件/焦点都在组件内部 —— 不接一下，用户在那几百毫秒里敲的字就白敲了。
   *
   * 口径（边界收得很窄，见 composer-carryover）：
   *   - **只在"实例还没就绪"的那一挂上留**（`pending` 非空 = 这一挂注定要重挂）；
   *   - 普通换会话（真 id → 真 id）不留：草稿跟着那一挂一起消失，是既有口径。
   * 接过来的草稿照样走"渲染后落位"那套：光标落到末尾、焦点交回输入框（用户接着敲）。
   */
  const pendingRef = useRef(pending)
  useEffect(() => {
    pendingRef.current = pending
  }, [pending])
  /**
   * 接上一挂留下的那一小包（见 composer-carryover）。**只在挂载时读一次** —— 读的是组件外部
   * （模块级过桥）的东西，不是渲染派生的状态，正是这条规则说的"与外部系统同步"；取回来落到
   * state 上（经 trackDraft 写入）。触发点是"重挂"这一次外部事件，一次挂载最多读一次
   * （过桥取走即清），不会级联。
   */
  /**
   * R92：**挂载那一刻**的放行位。过桥只在"重挂"这一次外部事件上读一次 —— 之后它再变化
   * （用户切走等）与这一挂无关，所以冻结成 ref（也正好避开 exhaustive-deps 的追问）。
   */
  const allowCarryoverRef = useRef(allowCarryover)
  useEffect(() => {
    // R92：这一次重挂被允许过桥吗 —— 不放行（用户主动换会话 / 新建 / 删除等）就**丢掉**残留，
    // 绝不让它漏进下一个会话（见 composer-carryover 的边界与 ChatPage 的 carryoverAllowed）。
    const carried = allowCarryoverRef.current
      ? takeComposerCarryover()
      : (discardComposerCarryover(), null)
    if (carried === null) return
    if (carried.text !== '') trackDraft(carried.text)
    if (carried.attachments.length > 0) setAttachments(carried.attachments)
    // 焦点交回输入框（光标落在末尾）：草稿非空、或重挂前它本来就 focus 着
    if (carried.text !== '' || carried.focused) setCaretToken(carried.text.length)
  }, [])
  useEffect(
    () => () => {
      if (pendingRef.current === null) return
      keepComposerCarryover({
        // 抄**输入框此刻真实写着什么**，不抄 `draftPropRef` 这个 state 镜像：两者会在"state 还没跟上
        // 用户这一下改动"时分叉（DOM 上有字、state 仍是空），而用户看得见的就是 DOM 那一份 ——
        // 以它为准，卸载时就不会把半句吞掉（这条口径由 composer-first.spec 的
        // 「DOM 有字、state 空」那条用例钉住）。`textareaRef` 此刻已被 React 置空，所以读
        // `lastTextareaRef`（回调 ref 存下的那个节点）。
        //
        // R92 补充（何时 DOM **不可信**）：只有"DOM 有**非空且与上一次 commit 不同**的值"才
        // 当"用户/浏览器新写进去的"以它为准；其余三种（空值 / 等于上一次 commit 的值 / 节点不在）
        // 都可能是受控恢复按旧 state 回写之后的产物（"同批重挂吞掉新输入"的那一轮，
        // v4 取证里 dom 与 state 双双为空）—— 改以 `draftTruthRef`（写入时同步记下的真值）为准。
        // 非吞路径下 truth 与真值同拍（每次写入都过 trackDraft），这条极窄，不会错带。
        text:
          lastTextareaRef.current !== null &&
          lastTextareaRef.current.value !== '' &&
          lastTextareaRef.current.value !== draftPropRef.current
            ? lastTextareaRef.current.value
            : draftTruthRef.current,
        attachments: attachmentsRef.current,
        focused:
          lastTextareaRef.current !== null && document.activeElement === lastTextareaRef.current
      })
    },
    []
  )

  return (
    // task-62：相对定位锚点（与输入卡同列宽）—— 状态海獭贴卡片**右缘/上沿**放，不占布局
    <div
      data-testid="composer-anchor"
      className="relative mx-auto w-full max-w-(--chat-input-max-width)"
    >
      {showOtter ? (
        <div
          data-testid="composer-otter"
          aria-hidden="true"
          className="composer-otter"
          title="kyclaw"
        >
          <PixelOtter state={CHAT_MASCOT_STATE[mascotState]} size={32} paused={motion.reduced} />
        </div>
      ) : null}
      <div
        data-testid="composer"
        className={cn(
          'composer-focus-surface focus-ring-container relative mx-auto w-full max-w-(--chat-input-max-width) rounded-[18px] border border-surface-border bg-(--field-bg) font-sans text-[15px] shadow-(--shadow-composer) transition-colors duration-(--motion-fast) ease-main motion-reduce:transition-none',
          // 拖拽悬停：描边换品牌色（只提示"松手就收"，不解释）
          dragging && 'border-(--accent)'
        )}
        // 拖拽入卡 = 与 ＋ 上传同一套口径（同一个 pickFiles）：hover 反白只是提示，判定都在 pickFiles
        onDragOver={(event) => {
          event.preventDefault()
          setDragging(true)
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
          setDragging(false)
        }}
        onDrop={(event) => {
          event.preventDefault()
          setDragging(false)
          void pickFiles(Array.from(event.dataTransfer.files))
        }}
        data-dragging={dragging ? 'true' : undefined}
      >
        {/* 建议浮窗（@ 文件 / 插件·技能）：浮在输入卡上方，非模态 */}
        <ComposerSuggest
          open={suggestOpen}
          groups={suggestionGroups}
          rowCount={suggestionRows.length}
          activeIndex={activeIndex}
          emptyText={
            suggest?.kind === 'file'
              ? '没有匹配的文件'
              : suggestionRows.length === 0 && (suggest?.query ?? '') === ''
                ? '还没有可引用的插件或技能'
                : '没有匹配的项'
          }
          notice={suggest?.kind === 'file' ? fileNotice : undefined}
          onPick={pickSuggestion}
          onHover={setActiveSuggestion}
        />
        <PendingChips
          attachments={attachments}
          onRemoveAttachment={(id) =>
            setAttachments((previous) => previous.filter((item) => item.id !== id))
          }
          onEditAttachment={(id, text) =>
            setAttachments((previous) =>
              previous.map((item) =>
                item.id === id ? { ...item, text, size: utf8ByteLength(text) } : item
              )
            )
          }
          onMentionAttachment={(_attachment, index) =>
            // 提及只是文字指路：插一段可 chip 化的引用（图片本体仍在附件里随消息真发）
            addReference({ kind: '图片', label: `图${index}` })
          }
        />

        {/* 输入区：随内容长高（field-sizing），到 --composer-input-max-height 封顶后内部滚动。
          焦点指示由卡片给（focus-ring-container）：输入框自己没有圆角，自己画环就是直角方框。
          round 21（图3 回归）：引用标记由**不透明覆盖层**画成 chip（细描边圆角 + 图标 +
          `kind：label`，`【引用】` 前缀不进可见层）。覆盖层在 textarea **之上**（z-20），
          本体 pointer-events-none / aria-hidden（只有 chip 上的 × 放行指针）；每段 chip 先放一个
          「隐形原文占位」（invisible + whitespace-pre）撑出**与原文等宽**的盒，视觉 chip 再绝对
          铺满这个盒——于是底层 textarea 的原始字形（含前缀）被完整盖住，后面的字一个也不挪位。
          代价（如实）：光标落在 chip 区域内不可见（chip 外正常）；标记长过一行时该行与 textarea
          的折行点可能差半行（隐形占位整段不内折）。chip 底用 **bg-secondary（不透明）**——
          Fills 系是半透明填充（5% 黑），当"盖字形"的底会透出原文。textarea 关掉拼写检查
          （spellCheck={false}，图1 的红波浪）。 */}
        <div className="relative">
          <div
            ref={mirrorRef}
            aria-hidden="true"
            data-testid="composer-mirror"
            className="pointer-events-none absolute inset-0 z-20 overflow-hidden text-transparent"
          >
            <div className="w-full px-4 py-3 font-sans text-b1 break-words whitespace-pre-wrap">
              {parseReferenceMarkers(draft).map((segment, index) =>
                segment.kind === 'text' ? (
                  <span key={index}>{segment.text}</span>
                ) : (
                  <span key={index} className="relative inline-block align-baseline">
                    {/* 隐形原文占位：chip 的盒宽 = 原文宽度（含前缀），chip 不出圆角、后面的字不挪位 */}
                    <span className="invisible whitespace-pre">{segment.raw}</span>
                    <span
                      data-testid="composer-ref-chip"
                      className="absolute inset-0 flex items-center gap-1 overflow-hidden rounded-pill border-(length:--hairline-width) border-hairline bg-secondary px-1.5 text-ink"
                    >
                      <ReferenceChipInner
                        refs={segment.refs}
                        trailing={
                          <button
                            type="button"
                            tabIndex={-1}
                            aria-hidden="true"
                            data-testid="composer-ref-remove"
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => removeReferenceSegment(segment)}
                            className="pointer-events-auto ml-auto inline-flex size-4 shrink-0 items-center justify-center rounded-pill text-ink-tertiary transition-colors duration-(--motion-fast) ease-main hover:bg-hover hover:text-ink motion-reduce:transition-none"
                          >
                            <X aria-hidden="true" className="size-3" />
                          </button>
                        }
                      />
                    </span>
                  </span>
                )
              )}
            </div>
          </div>
          {/* DSH placeholder：absolute 顶部、24 行高、14px、caption、nowrap ellipsis；有内容即消失 */}
          {draft === '' ? (
            <span
              data-testid="composer-placeholder"
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-4 top-2 z-0 truncate font-sans text-b2 leading-6 text-(--text-tertiary-readable)"
            >
              输入你的问题
            </span>
          ) : null}
          <textarea
            ref={attachTextarea}
            data-testid="composer-input"
            data-caret={caretCustom ? 'custom' : 'native'}
            data-composing={composing ? 'true' : undefined}
            aria-label="输入消息"
            rows={1}
            spellCheck={false}
            value={draft}
            onFocus={() => setComposerFocused(true)}
            onChange={(event) => {
              trackDraft(event.target.value)
              refreshTrigger(event.target.value, event.target.selectionStart)
              // P1b：输入中暂停闪烁（常亮）；--motion-flight（400ms）没输入再恢复 1s 闪
              setTyping(true)
              if (typingTimerRef.current !== null) window.clearTimeout(typingTimerRef.current)
              typingTimerRef.current = window.setTimeout(
                () => {
                  typingTimerRef.current = null
                  setTyping(false)
                },
                motionDurationMs('--motion-flight', 400)
              )
            }}
            onSelect={(event) => {
              // 光标移动（点击 / 方向键）也可能让触发出现或消失
              refreshTrigger(event.currentTarget.value, event.currentTarget.selectionStart)
              syncComposerCaret()
            }}
            onClick={() => syncComposerCaret()}
            onKeyUp={() => syncComposerCaret()}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={() => {
              setComposing(false)
              requestAnimationFrame(() => syncComposerCaret())
            }}
            onPaste={(event) => {
              // 粘贴入口（round 50）：截图工具贴的图 / 资源管理器贴的文件 → 与拖拽、＋ 上传
              // **同一条 pickFiles 管线**（同样的限额、vision=false 人话拒收、PDF 抽取）。
              // 没有文件就是纯文本粘贴：不拦截，保持默认行为。
              const files = clipboardFilesOf(event.clipboardData)
              if (files.length === 0) return
              event.preventDefault()
              void pickFiles(files)
            }}
            onBlur={() => {
              setComposerFocused(false)
              setSuggest(null)
            }}
            onScroll={(event) => {
              const mirror = mirrorRef.current
              if (mirror !== null) mirror.scrollTop = event.currentTarget.scrollTop
              syncComposerCaret()
            }}
            onKeyDown={(event) => {
              // 浮窗打开时有键盘优先级（输入法合成中不抢：方向键在选词）
              if (suggestOpen && !event.nativeEvent.isComposing) {
                if (event.key === 'ArrowDown' && suggestionRows.length > 0) {
                  event.preventDefault()
                  setActiveSuggestion((activeIndex + 1) % suggestionRows.length)
                  return
                }
                if (event.key === 'ArrowUp' && suggestionRows.length > 0) {
                  event.preventDefault()
                  setActiveSuggestion(
                    (activeIndex - 1 + suggestionRows.length) % suggestionRows.length
                  )
                  return
                }
                if (event.key === 'Enter' && activeRow !== null) {
                  event.preventDefault()
                  pickSuggestion(activeRow)
                  return
                }
                if (event.key === 'Escape') {
                  event.preventDefault()
                  setSuggest(null)
                  return
                }
              }
              if (event.key !== 'Enter' || event.shiftKey) return
              // 输入法合成中（中文/日文候选）的回车是在选词，不算发送
              if (event.nativeEvent.isComposing) return
              event.preventDefault()
              submit()
            }}
            className={cn(
              'composer-caret-input relative z-10 field-sizing-content block max-h-(--composer-input-max-height) w-full resize-none overflow-y-auto bg-transparent py-2 pr-10 pl-4 font-sans text-b2 leading-6 text-ink outline-none transition-[min-height] duration-(--motion-main) ease-main placeholder:text-(--text-tertiary-readable) focus-visible:shadow-none motion-reduce:transition-none',
              // round 64：常态 56、初始页一档更高（见 ComposerProps.hero）；换档有过渡，不硬切
              hero
                ? 'min-h-(--composer-input-min-height-hero)'
                : 'min-h-[calc(40px*var(--ui-scale,1))]'
            )}
          />
          {/* P1b：自绘 caret（原生 caret 由 .composer-caret-input[data-caret='custom'] 隐藏；
            composition / 含引用 chip 时 data-caret=native，交回原生，不猜位置） */}
          {caretCustom && caretPlacement.visible ? (
            <span
              data-testid="composer-caret"
              data-typing={typing ? 'true' : undefined}
              aria-hidden="true"
              className="composer-caret"
              style={{
                left: caretPlacement.left,
                top: caretPlacement.top,
                height: caretPlacement.height
              }}
            />
          ) : null}

          <div className="absolute right-2 bottom-2 z-30">
            {busy ? (
              <button
                type="button"
                data-testid="composer-stop"
                aria-label="停止生成"
                onClick={onStop}
                className="composer-send inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] font-mono text-[13px] text-ink transition-colors duration-(--motion-fast) ease-main hover:bg-hover focus-visible:outline-none motion-reduce:transition-none"
              >
                <svg viewBox="0 0 18 18" className="composer-send-mark size-5" aria-hidden="true">
                  <g
                    className="send-bracket send-bracket--l"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  >
                    <path d="M4.8 3.6H3.4v10.8h1.4" />
                  </g>
                  <g
                    className="send-bracket send-bracket--r"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  >
                    <path d="M13.2 3.6h1.4v10.8h-1.4" />
                  </g>
                  <rect
                    className="send-enter"
                    x="6.4"
                    y="6.4"
                    width="5.2"
                    height="5.2"
                    rx="0.6"
                    fill="currentColor"
                  />
                </svg>
              </button>
            ) : (
              <button
                type="button"
                data-testid="composer-send"
                aria-label="发送"
                disabled={!sendable}
                onClick={submit}
                className={cn(
                  'composer-send inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] font-mono text-[13px] transition-colors duration-(--motion-fast) ease-main focus-visible:outline-none motion-reduce:transition-none',
                  sendable
                    ? 'border border-transparent text-ink hover:bg-hover'
                    : 'cursor-not-allowed border border-surface-border bg-transparent text-(--text-tertiary-readable)'
                )}
              >
                <svg viewBox="0 0 18 18" className="composer-send-mark size-5" aria-hidden="true">
                  <g
                    className="send-bracket send-bracket--l"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  >
                    <path d="M4.8 3.6H3.4v10.8h1.4" />
                  </g>
                  <g
                    className="send-bracket send-bracket--r"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  >
                    <path d="M13.2 3.6h1.4v10.8h-1.4" />
                  </g>
                  <g
                    className="send-enter"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M12.2 6.2v3.4H6.2" />
                    <path d="M8.4 7.3 6.2 9.6l2.2 2.3" />
                  </g>
                </svg>
              </button>
            )}
          </div>
        </div>

        {shownNotice === null ? null : (
          <p
            data-testid="composer-notice"
            className={cn(
              'px-3 pb-1 text-c1',
              shownNotice.tone === 'danger'
                ? 'text-danger'
                : shownNotice.tone === 'success'
                  ? 'text-ink-secondary'
                  : 'text-warning'
            )}
          >
            {shownNotice.text}
          </p>
        )}

        <input
          ref={fileInputRef}
          data-testid="composer-file-input"
          type="file"
          multiple
          hidden
          onChange={(event) => {
            void pickFiles(Array.from(event.target.files ?? []))
            event.target.value = ''
          }}
        />
      </div>
      {/* task-131：footer 整行放回输入卡外、卡下方（同宽同 left、6px 间距、无边框/无卡面底） */}
      <div
        data-testid="composer-footer-outer"
        className="mx-auto mt-1.5 flex w-full max-w-(--chat-input-max-width) items-center px-1"
      >
        <div
          data-testid="composer-footer"
          className="flex h-(--composer-toolbar-height) w-full items-center gap-2"
        >
          <PlusMenu
            onAddFile={() => fileInputRef.current?.click()}
            onReference={addReference}
            contextLabel={contextLabel}
            plugins={enabledPlugins}
            skills={installedSkills}
            onOpenMenu={refreshSkills}
            mode={mode}
          />
          <PermissionChip
            workspace={rootWorkspace}
            reason={permissionReason}
            onNotice={setNotice}
          />

          <span className="min-w-0 flex-1 truncate">
            {blocked && pending.label !== null ? (
              <span
                data-testid="composer-pending"
                role="status"
                className="text-c1 text-ink-tertiary"
              >
                {pending.label}
              </span>
            ) : queuedCount > 0 ? (
              <span data-testid="composer-queue" className="text-c1 text-ink-secondary">
                已排队 {queuedCount} 条，当前回复结束后自动发出
              </span>
            ) : null}
          </span>

          {settings.providers.length === 0 ? null : (
            <>
              <ModelChip onNotice={setNotice} />
              <ContextChip
                threadId={threadId}
                onCompact={onCompact}
                compactBusy={compactBusy}
                compactDisabled={compactDisabled}
                usageVersion={usageVersion}
              />
            </>
          )}
        </div>
      </div>
    </div>
  )
}
