import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUp, Square, X } from 'lucide-react'
import { cn } from '@renderer/components/ui/cn'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { fetchPluginsOverview } from '@renderer/lib/plugins-api'
import { fetchThreadContext } from '@renderer/lib/usage-api'
import { thresholdTokensOf, usagePercentOf } from '@renderer/lib/compact'
import { useProjectsStore } from '@renderer/features/projects/projects-store'
import { visionOf } from '@shared/models'
import { PlusMenu, PermissionChip, ModelChip, PendingChips } from './ComposerControls'
import type { ComposerNotice } from './ComposerControls'
import { composeOutgoing, prepareAttachment } from './composer-attachments'
import type { OutgoingMessage, PdfExtractor, PendingAttachment } from './composer-attachments'
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
import { folderNameOf, sessionWorkspaceOf } from './session-workspace'

/**
 * 输入卡（UI 参考 §4.6 实测）：宽 max 768、圆角 24（--chat-input-radius）；
 * 结构 = （附件/引用 chip 行）+ 输入区（自适应，最小 48 / 最大 170，超出内部滚动）+
 * 底部工具条（48）：左起 ＋菜单（添加文件/引用技能/引用插件/引用上下文）、权限 chip（两档
 * ask|full，当前会话工作区）；右端模型 chip（T8 已配置 provider 的默认项；round 8 按用户实拍
 * 从左侧组移到右侧、发送钮之前）+ 发送/停止。
 *
 * 高度按 Kimi 实况页（a84af355 截图：单行输入 + 一行工具条），默认单行时紧凑，
 * 不再固定三段 "40 + 111 + 49" —— 那是首屏形态，常态下多出来的空白正是用户点名的"过高"。
 * 字号/提示不做小字说明（雷点 2）：键盘行为靠肌肉记忆与按钮语义，不写提示行；
 * 附件/引用的内容（名字/大小）是数据，不是解释性小字。
 *
 * 附件（round 7 起；模块 2 扩三类）：文本类 ≤16KB 读成文本内联；**图片**在当前模型 vision=true 时
 * 随消息真发（vision=false 人话拒收，不假装收下）；**PDF** 统一由主进程抽文字层再内联（扫描件给人话）。
 * 拖拽与 ＋ 上传走同一个 pickFiles —— 两条入口的行为必须是同一套。口径见 composer-attachments.ts 头注。
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
}

let uidCounter = 0
function uid(): string {
  uidCounter += 1
  return `c${uidCounter}-${Math.random().toString(36).slice(2, 7)}`
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
  externalNotice = null
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
  const projectOf = useProjectsStore((state) => state.projectOf)
  const rootWorkspace = sessionWorkspaceOf({ threadId, settings, projectOf })
  const contextLabel = rootWorkspace === null ? null : folderNameOf(rootWorkspace.path)
  const enabledPlugins = settings.mcpServers
    .filter((server) => server.enabled)
    .map((server) => ({ id: server.id, name: server.name }))
  /**
   * 当前模型能不能看图（模块 2）：用户覆盖 > 注册表 > false（口径见 shared/models 的 visionOf）。
   * 图片的收/拒在这一层定，UI 上不给解释性小字——拒的时候由 pickFiles 给一句人话。
   */
  const currentProvider =
    settings.providers.find((provider) => provider.isDefault) ?? settings.providers[0]
  const vision = visionOf(
    currentProvider?.model,
    currentProvider === undefined ? undefined : settings.modelCapabilities[currentProvider.model]
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
   * 收下一批文件（＋ 上传与拖拽共用这一条路）：逐个试收，收下的进附件条、
   * 没收的攒成一句话（档位与原因见 composer-attachments.ts）。
   */
  const pickFiles = async (files: File[]): Promise<void> => {
    const rejected: string[] = []
    const accepted: PendingAttachment[] = []
    for (const file of files) {
      const result = await prepareAttachment(file, { vision, extractPdf, id: uid() })
      if ('problem' in result) rejected.push(`${file.name}（${result.problem}）`)
      else accepted.push(result.attachment)
    }
    if (accepted.length > 0) setAttachments((previous) => [...previous, ...accepted])
    setNotice(
      rejected.length > 0 ? { tone: 'warning', text: `未附加：${rejected.join('、')}` } : null
    )
  }

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

        {settings.providers.length === 0 ? null : (
          <ModelChip threadId={threadId} onNotice={setNotice} />
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
