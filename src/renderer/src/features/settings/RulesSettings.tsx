import { useEffect, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { cn } from '@renderer/components/ui/cn'
import { Dialog, DialogClose } from '@renderer/components/ui/dialog'
import { Textarea } from '@renderer/components/ui/input'
import { Menu, type MenuEntry } from '@renderer/components/ui/menu'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { unwrapIpcError } from '@renderer/lib/ipc-error'
import { RULES_SCOPE_MAX_BYTES, rulesByteLength, rulesTextProblem } from '@shared/rules'
import type { ProjectRulesView } from '@shared/rules-ipc'
import type { AppSettings } from '@shared/settings'

/**
 * 设置页「记忆指令」块：全局与项目两份偏好，编辑器在 `RulesEntry` 的二级弹窗里。
 *
 * 左列菜单只有「记忆」一项（没有单独的「记忆指令」菜单）；旧深链 /settings/rules 由 sections.ts
 * 的别名落回「记忆」栏。全局走 settings:update（`globalRules`），项目走 projects:readRules /
 * saveRules、文件是项目内的 .kyclaw/rules.md。
 *
 * 状态行只在**本次运行还没接上记忆指令**时说话（正常运行时这行不出现）；窗口 focus 时重读一次
 * 状态（见下面 effect）。项目那一栏是产品自定义下拉（见 ProjectPicker）。
 */
const MAX_KIB = RULES_SCOPE_MAX_BYTES / 1024

function RuleEditor({
  scope,
  label,
  text,
  pending,
  onChange,
  onSave
}: {
  scope: 'global' | 'project'
  label: string
  text: string
  pending: boolean
  onChange: (text: string) => void
  onSave: (text: string) => void
}): React.JSX.Element {
  const problem = rulesTextProblem(text, scope)
  return (
    <div className="flex flex-col gap-2">
      <Textarea
        aria-label={label}
        value={text}
        disabled={pending}
        onChange={(event) => onChange(event.target.value)}
        rows={8}
        className="min-h-40"
      />
      {problem ? (
        <p role="alert" className="text-c1 text-danger">
          {problem.message}
        </p>
      ) : null}
      <div className="flex items-center justify-between gap-3">
        <div className="flex gap-2">
          <Button size="sm" disabled={pending || problem !== null} onClick={() => onSave(text)}>
            保存
          </Button>
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => onSave('')}>
            清空并保存
          </Button>
        </div>
        <p data-testid={`rules-bytes-${scope}`} className="text-c1 text-ink-tertiary">
          已用 {(rulesByteLength(text) / 1024).toFixed(1)} KiB / {MAX_KIB} KiB
        </p>
      </div>
    </div>
  )
}

/**
 * 项目下拉（002）：原生 select 换成产品自定义下拉（components/ui/menu —— 设置页「模型」栏的
 * 渠道下拉、对话页那枚「选择项目」胶囊用的都是它）。原生控件在深浅两色下都顶着系统外观，
 * 跟这一页其他字段不是一套皮。
 *
 * 行为口径一字不动：选中的项目就是下面那个编辑器的对象（选中即读它的 .kyclaw/rules.md）；
 * 没项目时给一条禁用的空态；选回「请选择项目」= 不挑项目，编辑器收起来。键盘 / Escape /
 * 点外关闭由 Radix 给；长名在触发元素上截断（全名挂 title），菜单里的条目仍写全名。
 */
function ProjectPicker({
  projects,
  projectId,
  onPick
}: {
  projects: AppSettings['projects']
  projectId: string
  onPick: (projectId: string) => void
}): React.JSX.Element {
  const current = projects.find((project) => project.id === projectId) ?? null
  const items: MenuEntry[] =
    projects.length === 0
      ? // 没项目也得能开：给一条禁用的空态（与对话页那枚胶囊同一口径），不装作有东西可选
        [{ id: 'empty', label: '还没有项目', disabled: true, testId: 'rules-project-empty' }]
      : [
          ...projects.map((project) => ({
            id: `project:${project.id}`,
            label: project.name,
            testId: `rules-project-${project.id}`,
            selected: project.id === projectId,
            onSelect: () => onPick(project.id)
          })),
          // 原来 select 里那个空选项留在这里：选回去就是不挑项目，下面的编辑器收起来
          ...(projectId === ''
            ? []
            : [
                { id: 'sep', type: 'separator' as const },
                {
                  id: 'none',
                  label: '请选择项目',
                  testId: 'rules-project-none',
                  onSelect: () => onPick('')
                }
              ])
        ]
  return (
    <div className="flex flex-col gap-2">
      <Menu
        align="start"
        items={items}
        // 项目多的时候整块菜单滚动（高度上限由 Radix 按可用空间算出来）
        className="max-h-(--radix-dropdown-menu-content-available-height) overflow-y-auto"
        trigger={
          <button
            type="button"
            data-testid="rules-project-select"
            aria-label="选择项目记忆指令"
            // 字段外观与设置页其他字段同档（40 高 / 圆角 12 / 半像素描边，见 components/ui/input）
            className="flex h-(--field-height) w-full items-center justify-between gap-2 rounded-field border-(length:--hairline-width) border-(--border-field) bg-(--field-bg) px-3 text-left text-b2 text-ink transition-colors duration-(--motion-fast) ease-main hover:bg-hover"
          >
            {/* 长名在这里截断（版面不被一个项目名撑破），全名挂 title；菜单里条目仍写全名 */}
            <span
              data-testid="rules-project-value"
              className={cn('min-w-0 truncate', current === null && 'text-(--text-quaternary)')}
              title={current?.name}
            >
              {current === null ? '请选择项目' : current.name}
            </span>
            <ChevronDown
              aria-hidden="true"
              className="size-(--icon-size-sm) shrink-0 text-ink-tertiary"
            />
          </button>
        }
      />
    </div>
  )
}

/**
 * 项目记忆指令编辑器。`draft` 受控时（入口那一层持有）：`null` = 跟着读回来的文件走，
 * 有值 = 用户没保存的输入；不传 = 组件自己存。保存成功一律回「`null` / 服务端原文」——
 * 只有保存过才算数，关掉弹窗不算。
 */
function ProjectRulesEditor({
  projectId,
  draft,
  onDraftChange
}: {
  projectId: string
  draft?: string | null
  onDraftChange?: (next: string | null) => void
}): React.JSX.Element {
  const [view, setView] = useState<ProjectRulesView | null>(null)
  /** 读回来的那份原文（受控模式下当前文本由它兜底） */
  const [fetched, setFetched] = useState('')
  const [internalText, setInternalText] = useState('')
  const text = draft === undefined ? internalText : (draft ?? fetched)
  const setText = (value: string): void => {
    if (onDraftChange === undefined) setInternalText(value)
    else onDraftChange(value)
  }
  const [pending, setPending] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  // preload 注入的常量桥：通道缺失在"读之前"就能确定，渲染期直接派生，不进 effect 同步 setState。
  // 项目 / 全局记忆指令变化由外层 key 重挂重置编辑器（见 RulesSettings 里 ProjectRulesEditor 的 key）——
  // 受控模式下重挂不丢草稿（输入在入口那一层），只把「读回来的原文 / 提示」重置。
  const channelMissing = window.kyclaw?.projects?.readRules === undefined
  useEffect(() => {
    let alive = true
    const api = window.kyclaw?.projects
    if (!api?.readRules) return
    api.readRules(projectId).then(
      (next) => {
        if (alive) {
          setView(next)
          setFetched(next.text)
          if (onDraftChange === undefined) setInternalText(next.text)
          setNotice('')
          setError('')
        }
      },
      (cause: unknown) => {
        if (alive) setError(unwrapIpcError(cause))
      }
    )
    return () => {
      alive = false
    }
    // onDraftChange 进依赖是安全的：受控那条路（RulesEntry）给的是 useState 的 setter，引用稳定；
    // 不传时是 undefined 也稳定 —— 这个 effect 只在换项目 / 全局改动重挂时才真正重跑
  }, [projectId, onDraftChange])
  const save = async (value: string): Promise<void> => {
    setPending(true)
    setNotice('')
    setError('')
    try {
      const api = window.kyclaw?.projects
      if (!api?.saveRules) throw new Error('暂时读不到项目记忆指令，未保存')
      const result = await api.saveRules(projectId, value)
      if (!result.ok) {
        setError(result.diagnostics.map((item) => item.message).join('；'))
        return
      }
      setView(result.view)
      setFetched(result.view.text)
      // 落盘后清草稿：当前文本回到服务端原文
      if (onDraftChange === undefined) setInternalText(result.view.text)
      else onDraftChange(null)
      setNotice('已保存')
    } catch (cause) {
      setError(unwrapIpcError(cause))
    } finally {
      setPending(false)
    }
  }
  return (
    <div className="flex flex-col gap-3">
      {view ? (
        <>
          {/* 来源只说项目内的相对位置（不铺长绝对路径占版面，与 013 同一方向）；真路径挂在
              tooltip 上，要核对这一点时悬停可见 */}
          <p className="text-c1 text-ink-tertiary" title={view.source}>
            .kyclaw/rules.md（项目内）
          </p>
          {view.projectIncluded ? null : (
            <p className="text-c1 text-ink-secondary">
              项目记忆指令不生效：没读到项目文件，或合计超限。
            </p>
          )}
          {view.diagnostics.map((item, index) => (
            <p role="alert" key={index} className="text-c1 text-danger">
              {item.message}
            </p>
          ))}
          <RuleEditor
            scope="project"
            label="项目记忆指令"
            text={text}
            pending={pending}
            onChange={(value) => {
              setText(value)
              // 012：内容又改了 → 上一次的「已保存」不再描述眼前这份内容
              setNotice('')
            }}
            onSave={(value) => void save(value)}
          />
          {notice ? (
            <p role="status" className="text-c1 text-ink-secondary">
              {notice}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-c1 text-danger">
              {error}
            </p>
          ) : null}
        </>
      ) : (
        <p className="text-b2 text-ink-secondary">正在读取项目记忆指令…</p>
      )}
      {channelMissing ? (
        <p role="status" className="text-c1 text-ink-tertiary">
          暂时读不到项目记忆指令。
        </p>
      ) : null}
    </div>
  )
}

/**
 * 可选的受控入口（`RulesEntry` 那条路用；不传 = 组件自己存）。存在的原因只有一条：
 * 弹窗关闭会卸载内容，草稿得挂在**不卸载**的那一层，关掉再打开才不丢没保存的输入。
 */
export interface RulesSettingsProps {
  /** 全局草稿：null = 跟 store 走（没编辑过），有值 = 用户在编辑 */
  draft?: string | null
  onDraftChange?: (next: string | null) => void
  projectId?: string
  onProjectIdChange?: (next: string) => void
  /** 项目草稿：null = 跟读回来的文件走 */
  projectDraft?: string | null
  onProjectDraftChange?: (next: string | null) => void
}

export function RulesSettings(props: RulesSettingsProps = {}): React.JSX.Element {
  const settings = useSettingsStore((state) => state.settings)
  // 草稿：null = 跟 store 走（没编辑过），有值 = 用户在编辑（未保存内容保护）。
  // 不再用 effect 把 store 的值同步回草稿 —— 那会连带把没保存的输入顶掉。
  const [internalDraft, setInternalDraft] = useState<string | null>(null)
  const draft = props.draft === undefined ? internalDraft : props.draft
  const setDraft = props.onDraftChange ?? setInternalDraft
  const text = draft ?? settings.globalRules
  const [internalProjectId, setInternalProjectId] = useState('')
  const projectId = props.projectId ?? internalProjectId
  const setProjectId = props.onProjectIdChange ?? setInternalProjectId
  /** 本次运行还没接上记忆指令（只有"没接上"要在页面上说话；接上了什么都不显示） */
  const [notActive, setNotActive] = useState(false)
  const [statusError, setStatusError] = useState('')
  useEffect(() => {
    // 只在"没接上"时给一行提示：注册状态是运行事实，窗口 focus 时重读一次，不靠按钮也能自愈。
    let alive = true
    let generation = 0
    const refresh = (): void => {
      const request = ++generation
      const api = window.kyclaw?.projects
      if (!api?.rulesStatus) {
        setNotActive(false)
        setStatusError('暂时读不到记忆指令的启用状态。')
        return
      }
      api.rulesStatus().then(
        (status) => {
          if (alive && request === generation) {
            setNotActive(!status.processorRegistered)
            setStatusError('')
          }
        },
        (cause: unknown) => {
          if (alive && request === generation) {
            setNotActive(false)
            setStatusError(unwrapIpcError(cause))
          }
        }
      )
    }
    refresh()
    window.addEventListener('focus', refresh)
    return () => {
      alive = false
      window.removeEventListener('focus', refresh)
    }
  }, [])
  const [pending, setPending] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const save = async (value: string): Promise<void> => {
    setPending(true)
    setNotice('')
    setError('')
    try {
      const api = window.kyclaw?.settings
      if (!api) throw new Error('设置通道不可用，未保存')
      const next = await api.update({ globalRules: value })
      useSettingsStore.setState({ settings: next })
      // 落盘后清草稿：text 回到 store 的权威值（= next.globalRules）；失败路径不清，草稿留着
      setDraft(null)
      setNotice('已保存')
    } catch (cause) {
      setError(unwrapIpcError(cause))
    } finally {
      setPending(false)
    }
  }
  return (
    <div className="flex flex-col gap-5" data-testid="settings-group-rules">
      <div className="flex flex-col gap-2">
        <div className="flex flex-col gap-0.5">
          <span className="text-b2 text-ink">全局</span>
          <p className="text-c1 text-ink-secondary">
            对所有会话生效；同一条在项目里写了以项目为准。
          </p>
        </div>
        <RuleEditor
          scope="global"
          label="全局记忆指令"
          text={text}
          pending={pending}
          // 012：输入一动，上一次的「已保存」就不再描述眼前这份内容（与「关于」栏对齐）；
          // 保存中 textarea/按钮都是 disabled（pending），草稿只在保存失败时才留着
          onChange={(value) => {
            setDraft(value)
            setNotice('')
          }}
          onSave={(value) => void save(value)}
        />
        {notice ? (
          <p data-testid="rules-notice" role="status" className="text-c1 text-ink-secondary">
            {notice}
          </p>
        ) : null}
        {error ? (
          <p data-testid="rules-error" role="alert" className="text-c1 text-danger">
            {error}
          </p>
        ) : null}
        {notActive ? (
          <p data-testid="rules-not-active" role="status" className="text-c1 text-ink-tertiary">
            本次运行还没接上记忆指令，重启应用后生效。
          </p>
        ) : null}
        {statusError ? (
          <p role="alert" className="text-c1 text-danger">
            {statusError}
          </p>
        ) : null}
      </div>

      {/* 项目那一份：与全局分开一段（上面是全局偏好，这里是某一个项目的） */}
      <div className="flex flex-col gap-2 border-t border-surface-border pt-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-b2 text-ink">项目</span>
          <p className="text-c1 text-ink-secondary">
            选中哪个项目就改它那一份；与全局合计最多 24 KiB。
          </p>
        </div>
        <ProjectPicker projects={settings.projects} projectId={projectId} onPick={setProjectId} />
        {settings.projects.some((project) => project.id === projectId) ? (
          // key 带上 globalRules：全局记忆指令一变就得重读项目记忆指令（合计上限受它影响）——
          // 靠重挂重置编辑器状态（view / 草稿 / 提示），不再在 effect 里同步 setView(null)
          <ProjectRulesEditor
            key={JSON.stringify([projectId, settings.globalRules])}
            projectId={projectId}
            draft={props.projectDraft}
            onDraftChange={props.onProjectDraftChange}
          />
        ) : null}
      </div>
    </div>
  )
}

/**
 * 记忆指令入口：一行标签 + 「编辑」，编辑器在二级弹窗里。
 *
 * 草稿**挂在入口这一层**（不是弹窗里）：Radix 弹窗关掉会卸载内容，草稿跟着没；入口常驻在设置页上，
 * 弹窗开合只影响"谁在显示它们"——关掉再打开，没保存的输入原样还在；只有保存成功才清草稿、才说
 * 「已保存」（不做"关掉即保存"那种假动作）。焦点：按钮即弹窗 trigger，Esc / X / 蒙层关掉后回到它。
 */
export function RulesEntry(): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  const [projectId, setProjectId] = useState('')
  const [projectDraft, setProjectDraft] = useState<string | null>(null)

  /** 换项目 = 换一份文件：上一份没保存的输入不带到新项目上 */
  const pickProject = (next: string): void => {
    setProjectId(next)
    setProjectDraft(null)
  }

  return (
    <div data-testid="rules-entry" className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-b2 text-ink">记忆指令</span>
        <Dialog
          trigger={
            <Button size="sm" variant="ghost" data-testid="rules-open">
              编辑
            </Button>
          }
          title="记忆指令"
          description="保存后下一轮对话生效；关掉不会丢掉没保存的内容。"
          size="md"
        >
          <DialogClose />
          <div data-testid="rules-dialog-body" className="max-h-[60vh] overflow-y-auto">
            <RulesSettings
              draft={draft}
              onDraftChange={setDraft}
              projectId={projectId}
              onProjectIdChange={pickProject}
              projectDraft={projectDraft}
              onProjectDraftChange={setProjectDraft}
            />
          </div>
        </Dialog>
      </div>
      <p className="text-c1 text-ink-secondary">全局与项目各一份，点开编辑。</p>
    </div>
  )
}
