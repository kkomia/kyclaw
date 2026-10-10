import { useRef, useState } from 'react'
import { ArrowUp, Square } from 'lucide-react'
import { cn } from '@renderer/components/ui/cn'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { useProjectsStore } from '@renderer/features/projects/projects-store'
import { PlusMenu, PermissionChip, ModelChip, PendingChips } from './ComposerControls'
import type { ComposerNotice } from './ComposerControls'
import { attachmentProblem, composeOutgoingText, readTextFile } from './composer-attachments'
import type { PendingAttachment, PendingReference } from './composer-attachments'
import { folderNameOf, sessionWorkspaceOf } from './session-workspace'

/**
 * 输入卡（UI 参考 §4.6 实测）：宽 max 768、圆角 24（--chat-input-radius）；
 * 结构 = （附件/引用 chip 行）+ 输入区（自适应，最小 48 / 最大 170，超出内部滚动）+
 * 底部工具条（48）：左起 ＋菜单（添加文件/引用技能/引用插件/引用上下文）、权限 chip（两档
 * ask|full，当前会话工作区）、模型 chip（T8 已配置 provider 的默认项）；右端发送/停止。
 *
 * 高度按 Kimi 实况页（a84af355 截图：单行输入 + 一行工具条），默认单行时紧凑，
 * 不再固定三段 "40 + 111 + 49" —— 那是首屏形态，常态下多出来的空白正是用户点名的"过高"。
 * 字号/提示不做小字说明（雷点 2）：键盘行为靠肌肉记忆与按钮语义，不写提示行；
 * 附件/引用的内容（名字/大小）是数据，不是解释性小字。
 *
 * 附件最小可用（round 7）：只收文本类、≤16KB，内容在发送时内联进消息文本（模型真正能读到；
 * file part 走 provider 看不到内容，实测见 composer-attachments.ts 头注），非文本/过大明确提示不收。
 *
 * 交互：Enter 发送 / Shift+Enter 换行（输入法合成中不拦截）；流式中发送钮变停止（stop()）；
 * 流式中按下发送不丢内容 —— 交给上层排队（见 ChatPage 的队列）。组件只把组装好的文本抛上去。
 */
export interface ComposerProps {
  /** 当前会话 id（权限 chip 判"会话的工作区根"用；判不出就不渲染权限入口） */
  threadId?: string | null
  /** 流式中（submitted / streaming）：发送钮切换为停止 */
  busy?: boolean
  /** 已排队的条数（流式中发送的消息），0 时不显示 */
  queuedCount?: number
  onSend: (text: string) => void
  onStop: () => void
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
  onStop
}: ComposerProps): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [attachments, setAttachments] = useState<PendingAttachment[]>([])
  const [references, setReferences] = useState<PendingReference[]>([])
  const [notice, setNotice] = useState<ComposerNotice | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const settings = useSettingsStore((state) => state.settings)
  const projectOf = useProjectsStore((state) => state.projectOf)
  const rootWorkspace = sessionWorkspaceOf({ threadId, settings, projectOf })
  const contextLabel = rootWorkspace === null ? null : folderNameOf(rootWorkspace.path)
  const enabledPlugins = settings.mcpServers
    .filter((server) => server.enabled)
    .map((server) => ({ id: server.id, name: server.name }))

  const canSend = draft.trim() !== '' || attachments.length > 0

  const submit = (): void => {
    if (!canSend) return
    onSend(composeOutgoingText({ text: draft, references, attachments }))
    setDraft('')
    setAttachments([])
    setReferences([])
    setNotice(null)
  }

  const addReference = (reference: Pick<PendingReference, 'kind' | 'label'>): void => {
    setReferences((previous) => {
      const id = `${reference.kind}:${reference.label}`
      if (previous.some((item) => item.id === id)) return previous
      return [...previous, { id, kind: reference.kind, label: reference.label }]
    })
  }

  const pickFiles = async (files: File[]): Promise<void> => {
    const rejected: string[] = []
    const accepted: PendingAttachment[] = []
    for (const file of files) {
      const problem = attachmentProblem(file)
      if (problem !== null) {
        rejected.push(`${file.name}（${problem}）`)
        continue
      }
      try {
        const text = await readTextFile(file)
        accepted.push({ id: uid(), name: file.name, size: file.size, text })
      } catch {
        rejected.push(`${file.name}（读取失败）`)
      }
    }
    if (accepted.length > 0) setAttachments((previous) => [...previous, ...accepted])
    setNotice(
      rejected.length > 0 ? { tone: 'warning', text: `未附加：${rejected.join('、')}` } : null
    )
  }

  return (
    <div
      data-testid="composer"
      className="focus-ring-container mx-auto w-full max-w-(--chat-input-max-width) rounded-input border-(length:--hairline-width) border-(--border-field) bg-(--field-bg) shadow-(--shadow-input)"
    >
      <PendingChips
        attachments={attachments}
        references={references}
        onRemoveAttachment={(id) =>
          setAttachments((previous) => previous.filter((item) => item.id !== id))
        }
        onRemoveReference={(id) =>
          setReferences((previous) => previous.filter((item) => item.id !== id))
        }
      />

      {/* 输入区：随内容长高（field-sizing），到 --composer-input-max-height 封顶后内部滚动。
          焦点指示由卡片给（focus-ring-container）：输入框自己没有圆角，自己画环就是直角方框。 */}
      <textarea
        data-testid="composer-input"
        aria-label="输入消息"
        rows={1}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.shiftKey) return
          // 输入法合成中（中文/日文候选）的回车是在选词，不算发送
          if (event.nativeEvent.isComposing) return
          event.preventDefault()
          submit()
        }}
        placeholder="输入你的问题"
        className="field-sizing-content block max-h-(--composer-input-max-height) min-h-(--composer-input-min-height) w-full resize-none overflow-y-auto bg-transparent px-4 py-3 text-b1 text-ink outline-none placeholder:text-(--text-quaternary) focus-visible:shadow-none"
      />

      {notice === null ? null : (
        <p
          data-testid="composer-notice"
          className={cn(
            'px-3 pb-1 text-c1',
            notice.tone === 'danger' ? 'text-danger' : 'text-warning'
          )}
        >
          {notice.text}
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

      {/* 工具条：左起 ＋菜单 / 权限 chip / 模型 chip；中间留给状态（排队条数）；右端发送 / 停止 */}
      <div
        data-testid="composer-footer"
        className="flex h-(--composer-toolbar-height) items-center gap-2 px-3"
      >
        <PlusMenu
          onAddFile={() => fileInputRef.current?.click()}
          onReference={addReference}
          contextLabel={contextLabel}
          plugins={enabledPlugins}
        />
        {rootWorkspace === null ? null : (
          <PermissionChip workspace={rootWorkspace} onNotice={setNotice} />
        )}
        {settings.providers.length === 0 ? null : <ModelChip onNotice={setNotice} />}

        <span className="min-w-0 flex-1 truncate">
          {queuedCount > 0 ? (
            <span data-testid="composer-queue" className="text-c1 text-ink-secondary">
              已排队 {queuedCount} 条，当前回复结束后自动发出
            </span>
          ) : null}
        </span>

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
                : 'bg-(--fill-disabled) text-(--text-disabled)'
            )}
          >
            <ArrowUp aria-hidden="true" className="size-5" strokeWidth={2.4} />
          </button>
        )}
      </div>
    </div>
  )
}
