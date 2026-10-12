import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUp, Square, X } from 'lucide-react'
import { cn } from '@renderer/components/ui/cn'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { fetchPluginsOverview } from '@renderer/lib/plugins-api'
import { fetchThreadContext } from '@renderer/lib/usage-api'
import { thresholdTokensOf, usagePercentOf } from '@renderer/lib/compact'
import { useProjectsStore } from '@renderer/features/projects/projects-store'
import { probedKeyOf, visionOf } from '@shared/models'
import { PlusMenu, PermissionChip, ContextChip, ModelChip, PendingChips } from './ComposerControls'
import type { ComposerNotice } from './ComposerControls'
import { composeOutgoing, prepareAttachment } from './composer-attachments'
import type { OutgoingMessage, PdfExtractor, PendingAttachment } from './composer-attachments'
import { resolveContextItem, subscribeContextItems } from './composer-inbox'
import { ComposerSuggest } from './ComposerSuggest'
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

/**
 * 输入卡（UI 参考 §4.6 实测）：宽 max 768、圆角 24（--chat-input-radius）；
 * 结构 = （附件/引用 chip 行）+ 输入区（自适应，最小 48 / 最大 170，超出内部滚动）+
 * 底部工具条（48）：左起 ＋菜单（添加文件/引用技能/引用插件/引用上下文）、权限 chip（两档
 * ask|full，当前会话工作区）；右端（round 42 二轮起）**上下文环**（独立组件 ContextChip）+ 模型 chip
 * （T8 已配置 provider 的默认项；round 8 按用户实拍从左侧组移到右侧、发送钮之前）+ 发送/停止。
 * round 57：用量 ≥ 80% 时 ContextChip 会在环**左边**多渲染一枚「压缩上下文」胶囊（点即压缩）。
 *
 * 高度按 Kimi 实况页（a84af355 截图：单行输入 + 一行工具条），默认单行时紧凑，
 * 不再固定三段 "40 + 111 + 49" —— 那是首屏形态，常态下多出来的空白正是用户点名的"过高"。
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
 *
 * 引用（round 14 起=光标处内联标记；round 21 换图3 观感：不透明覆盖层画 chip）：`＋ → 引用…`
 * 与 round 15 的建议浮窗同一条路 ——
 * 键入 `@`（词边界）浮出工作区文件、键入 `/` 浮出插件/技能（见 suggestion-model.ts 与
 * ComposerSuggest.tsx），选中都把触发段替换成 `【引用】<kind>：<label>` 标记。
 *
 * 交互：Enter 发送 / Shift+Enter 换行（输入法合成中不拦截；**浮窗打开时** ↑/↓ 走条目、Enter 选中、
 * Esc 关浮窗）；流式中发送钮变停止（stop()）；流式中按下发送不丢内容 —— 交给上层排队（见 ChatPage）。
 */
export interface ComposerProps {
  /** 当前会话 id（权限 chip 判"会话的工作区根"用；判不出就不渲染权限入口） */
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
  /** 压压缩结果的一行 notice（由上层给：成功/失败/降级）；与附件等内部 notice 合并显示 */
  externalNotice?: ComposerNotice | null
  /**
   * round 57：上下文用量的**取数刷新信号**（上层每轮结束 +1）——透给上下文环那侧的
   * 「压缩上下文」胶囊，让它在用量越过出现线时及时露面（环自己也跟着变新）。
   */
  usageVersion?: number
}

let uidCounter = 0
function uid(): string {
  uidCounter += 1
  return `c${uidCounter}-${Math.random().toString(36).slice(2, 7)}`
}

/**
 * 剪贴板里的文件（round 50 粘贴入口）：`files` 与 `items`（kind === 'file'）两处都看 ——
 * 截图工具与资源管理器在不同平台上填的不是同一处，两处同源时按元数据去重。
 * 一个文件都没有 = 纯文本粘贴：调用方**不拦截**，保持默认行为。
 */
function clipboardFilesOf(data: DataTransfer | null): File[] {
  const keyOf = (file: File): string =>
    `${file.name}\u0000${file.size}\u0000${file.type}\u0000${file.lastModified}`
  if (data === null) return []
  const files: File[] = Array.from(data.files ?? [])
  const seen = new Set(files.map(keyOf))
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
  usageVersion = 0
}: ComposerProps): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [attachments, setAttachments] = useState<PendingAttachment[]>([])
  const [notice, setNotice] = useState<ComposerNotice | null>(null)
  /** 拖拽悬停中（只做视觉提示；收不收还是 pickFiles 说了算） */
  const [dragging, setDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  /** 引用覆盖层（chip 的盖层）：与 textarea 同排版，随内容滚动（round 21 起在 textarea 之上） */
  const mirrorRef = useRef<HTMLDivElement>(null)
  /** 插入标记后待落的光标位（渲染完再设 selection，避免用旧值越界） */
  const pendingCaret = useRef<number | null>(null)

  const settings = useSettingsStore((state) => state.settings)
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
              command: { percent: usagePercent, busy: compactBusy, disabled: compactDisabled }
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

  /** 打开 `/` 时取一次使用率（命令行「压缩上下文」的次要位是数值展示，不是解释小字） */
  useEffect(() => {
    if (suggest?.kind !== 'slash' || threadId === null || threadId === '') return
    let alive = true
    void fetchThreadContext(threadId).then(
      (context) => {
        if (alive) setUsagePercent(usagePercentOf(context.lastInput, thresholdTokensOf(settings)))
      },
      () => {
        // 取不到（服务没起来 / 单测未装桥）：不显示数值，命令照常可用
        if (alive) setUsagePercent(null)
      }
    )
    return () => {
      alive = false
    }
  }, [suggest?.kind, threadId, settings])

  /** 选中一条建议：命令行走"立即执行"（移除触发段）；引用行把触发段换成引用标记 */
  const pickSuggestion = (row: SuggestionRow): void => {
    if (suggest === null || row.disabled === true) return
    if (row.command === 'compact') {
      const remaining = draft.slice(0, suggest.start) + draft.slice(suggest.end)
      pendingCaret.current = suggest.start
      setDraft(remaining)
      setSuggest(null)
      onCompact?.()
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
    pendingCaret.current = inserted.caret
    setDraft(inserted.text)
    setSuggest(null)
  }

  const canSend = draft.trim() !== '' || attachments.length > 0
  /** 内部 notice（附件/权限）优先；没有时显示上层给的压缩结果 notice（round 19） */
  const shownNotice = notice ?? externalNotice

  /** round 21：× 删掉一段引用 chip（按段的 [start, start+raw.length) 精确替换；光标落在段起点） */
  const removeReferenceSegment = (segment: { start: number; raw: string }): void => {
    const start = Math.max(0, Math.min(segment.start, draft.length))
    const end = Math.min(draft.length, start + segment.raw.length)
    pendingCaret.current = start
    setDraft(draft.slice(0, start) + draft.slice(end))
  }

  const submit = (): void => {
    if (!canSend) return
    onSend(composeOutgoing({ text: draft, attachments }))
    setDraft('')
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
    pendingCaret.current = inserted.caret
    setDraft(inserted.text)
  }

  /** 插入标记后的光标落位（每次渲染后检查一次 pendingCaret；无待办就什么都不做） */
  useEffect(() => {
    if (pendingCaret.current === null) return
    const textarea = textareaRef.current
    if (textarea === null) return
    textarea.focus()
    textarea.setSelectionRange(pendingCaret.current, pendingCaret.current)
    pendingCaret.current = null
  })

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
   */
  useEffect(() => {
    if (threadId === null) return
    // 换会话 / 卸载时把这条订阅收掉：晚到的解析结果不再往新会话的附件条上挂（与 listFiles 同一套 alive 口径）
    let alive = true
    const unsubscribe = subscribeContextItems((item) => {
      if (item.threadId !== threadId) return
      void resolveContextItem(item, {
        channel: window.kyclaw?.workbench ?? null,
        vision,
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
  }, [threadId, vision, extractPdf])

  return (
    <div
      data-testid="composer"
      className={cn(
        'focus-ring-container relative mx-auto w-full max-w-(--chat-input-max-width) rounded-input border-(length:--hairline-width) border-(--border-field) bg-(--field-bg) shadow-(--shadow-input) transition-colors duration-(--motion-fast) ease-main motion-reduce:transition-none',
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
          <div className="w-full px-4 py-3 text-b1 break-words whitespace-pre-wrap">
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
        <textarea
          ref={textareaRef}
          data-testid="composer-input"
          aria-label="输入消息"
          rows={1}
          spellCheck={false}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value)
            refreshTrigger(event.target.value, event.target.selectionStart)
          }}
          onSelect={(event) => {
            // 光标移动（点击 / 方向键）也可能让触发出现或消失
            refreshTrigger(event.currentTarget.value, event.currentTarget.selectionStart)
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
          onBlur={() => setSuggest(null)}
          onScroll={(event) => {
            const mirror = mirrorRef.current
            if (mirror !== null) mirror.scrollTop = event.currentTarget.scrollTop
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
          placeholder="输入你的问题"
          className="relative z-10 field-sizing-content block max-h-(--composer-input-max-height) min-h-(--composer-input-min-height) w-full resize-none overflow-y-auto bg-transparent px-4 py-3 text-b1 text-ink outline-none placeholder:text-(--text-quaternary) focus-visible:shadow-none"
        />
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

      {/* 工具条：左起 ＋菜单 / 权限 chip；中间留给状态（排队条数）；右端模型 chip + 发送 / 停止
          （round 8：模型 chip 按用户实拍移到右侧组，且在发送钮之前） */}
      <div
        data-testid="composer-footer"
        className="flex h-(--composer-toolbar-height) items-center gap-2 px-3"
      >
        <PlusMenu
          onAddFile={() => fileInputRef.current?.click()}
          onReference={addReference}
          contextLabel={contextLabel}
          plugins={enabledPlugins}
          skills={installedSkills}
          onOpenMenu={refreshSkills}
        />
        {rootWorkspace === null ? null : (
          <PermissionChip workspace={rootWorkspace} onNotice={setNotice} />
        )}

        <span className="min-w-0 flex-1 truncate">
          {queuedCount > 0 ? (
            <span data-testid="composer-queue" className="text-c1 text-ink-secondary">
              已排队 {queuedCount} 条，当前回复结束后自动发出
            </span>
          ) : null}
        </span>

        {/* round 42 二轮：上下文环与模型选择是**两个组件**（两个目标），只是相邻着放；
            round 57：环左边那枚「压缩上下文」胶囊由 ContextChip 自己按用量决定出不出（同层兄弟） */}
        {settings.providers.length === 0 ? null : (
          <>
            <ContextChip
              threadId={threadId}
              onCompact={onCompact}
              compactBusy={compactBusy}
              compactDisabled={compactDisabled}
              usageVersion={usageVersion}
            />
            <ModelChip onNotice={setNotice} />
          </>
        )}

        {busy ? (
          <button
            type="button"
            data-testid="composer-stop"
            aria-label="停止生成"
            onClick={onStop}
            className="flex size-9 items-center justify-center rounded-pill bg-(--button-primary-bg) text-(--button-primary-fg) transition-colors duration-(--motion-fast) ease-main hover:bg-(--button-primary-bg-hover) motion-reduce:transition-none"
          >
            <Square aria-hidden="true" className="size-4 fill-current" />
          </button>
        ) : (
          <button
            type="button"
            data-testid="composer-send"
            aria-label="发送"
            disabled={!canSend}
            onClick={submit}
            className={cn(
              'flex size-9 items-center justify-center rounded-pill transition-colors duration-(--motion-fast) ease-main motion-reduce:transition-none',
              canSend
                ? 'bg-(--button-primary-bg) text-(--button-primary-fg) hover:bg-(--button-primary-bg-hover)'
                : // round 17（用户实拍"禁用态糊"）：图标从 Labels-Quaternary（30% 黑，糊在浅灰底上）
                  // 提到 Labels-Tertiary（55% 黑）——干净可辨、又不至于像可用（可用的墨色圆底完全另一档）。
                  // 线宽保持 2.4：20px 渲染时正好是 device 2px（2.4 × 20/24），在像素网格上不发虚。
                  'bg-(--fill-disabled) text-(--text-tertiary)'
            )}
          >
            <ArrowUp aria-hidden="true" className="size-5" strokeWidth={2.4} />
          </button>
        )}
      </div>
    </div>
  )
}
