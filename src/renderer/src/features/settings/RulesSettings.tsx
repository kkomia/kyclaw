import { useEffect, useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { unwrapIpcError } from '@renderer/lib/ipc-error'
import { RULES_SCOPE_MAX_BYTES, rulesByteLength, rulesTextProblem } from '@shared/rules'
import type { ProjectRulesView } from '@shared/rules-ipc'

/**
 * 设置页「约束」栏（用户口径 008/009）：**一个输入框 + 一句说明**，删掉面向开发者的内部文案
 * （globalRules 键名、处理器注册状态、刷新按钮、读取范围那几句）。
 *
 * 行为层照旧：全局走 settings:update（`globalRules`），项目走 projects:readRules / saveRules，
 * 读写与持久化口径没动 —— 这一轮只改展示层与文案。
 *
 * 状态行只留用户能感知的一件事：**本次运行还没接上约束**时给一行提示（正常运行时这行不出现）。
 * 原来那颗「刷新规则状态」按钮撤了，能力没丢：窗口 focus 时仍会重读一次状态（见下面 effect）。
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
    <div className="flex flex-col gap-3">
      <textarea
        aria-label={label}
        value={text}
        disabled={pending}
        onChange={(event) => onChange(event.target.value)}
        rows={10}
        className="rounded-lg border border-border bg-transparent p-3 text-b2 text-ink"
      />
      <p className="text-c1 text-ink-tertiary">
        已用 {(rulesByteLength(text) / 1024).toFixed(1)} KiB / {MAX_KIB} KiB
      </p>
      {problem ? (
        <p role="alert" className="text-c1 text-danger">
          {problem.message}
        </p>
      ) : null}
      <div className="flex gap-3">
        <Button disabled={pending || problem !== null} onClick={() => onSave(text)}>
          保存
        </Button>
        <Button disabled={pending} onClick={() => onSave('')}>
          清空并保存
        </Button>
      </div>
    </div>
  )
}

function ProjectRulesEditor({ projectId }: { projectId: string }): React.JSX.Element {
  const [view, setView] = useState<ProjectRulesView | null>(null)
  const [text, setText] = useState('')
  const [pending, setPending] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  // preload 注入的常量桥：通道缺失在"读之前"就能确定，渲染期直接派生，不进 effect 同步 setState。
  // 项目 / 全局约束变化由外层 key 重挂重置编辑器（见 RulesSettings 里 ProjectRulesEditor 的 key）。
  const channelMissing = window.kyclaw?.projects?.readRules === undefined
  useEffect(() => {
    let alive = true
    const api = window.kyclaw?.projects
    if (!api?.readRules) return
    api.readRules(projectId).then(
      (next) => {
        if (alive) {
          setView(next)
          setText(next.text)
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
  }, [projectId])
  const save = async (value: string): Promise<void> => {
    setPending(true)
    setNotice('')
    setError('')
    try {
      const api = window.kyclaw?.projects
      if (!api?.saveRules) throw new Error('暂时读不到项目约束，未保存')
      const result = await api.saveRules(projectId, value)
      if (!result.ok) {
        setError(result.diagnostics.map((item) => item.message).join('；'))
        return
      }
      setView(result.view)
      setText(result.view.text)
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
              项目约束不生效：没读到项目文件，或合计超限。
            </p>
          )}
          {view.diagnostics.map((item, index) => (
            <p role="alert" key={index} className="text-c1 text-danger">
              {item.message}
            </p>
          ))}
          <RuleEditor
            scope="project"
            label="项目约束"
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
        <p className="text-b2 text-ink-secondary">正在读取项目约束…</p>
      )}
      {channelMissing ? (
        <p role="status" className="text-c1 text-ink-tertiary">
          暂时读不到项目约束。
        </p>
      ) : null}
    </div>
  )
}

export function RulesSettings(): React.JSX.Element {
  const settings = useSettingsStore((state) => state.settings)
  // 草稿：null = 跟 store 走（没编辑过），有值 = 用户在编辑（未保存内容保护）。
  // 不再用 effect 把 store 的值同步回草稿 —— 那会连带把没保存的输入顶掉。
  const [draft, setDraft] = useState<string | null>(null)
  const text = draft ?? settings.globalRules
  const [projectId, setProjectId] = useState('')
  /** 本次运行还没接上约束（只有"没接上"要在页面上说话；接上了什么都不显示） */
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
        setStatusError('暂时读不到约束的启用状态。')
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
    <div className="flex flex-col gap-6" data-testid="settings-group-rules">
      <div className="flex flex-col gap-3">
        <p className="text-b2 text-ink-secondary">对所有会话生效；项目里写了同一条时以项目为准。</p>
        <RuleEditor
          scope="global"
          label="全局约束"
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
            本次运行还没接上约束，重启应用后生效。
          </p>
        ) : null}
        {statusError ? (
          <p role="alert" className="text-c1 text-danger">
            {statusError}
          </p>
        ) : null}
      </div>

      {/* 项目约束：与全局分开一段（上面是全局偏好，这里是某一个项目的） */}
      <div className="flex flex-col gap-3 border-t border-surface-border pt-4">
        <p className="text-c1 text-ink-secondary">
          项目约束写在该项目里的 .kyclaw/rules.md；与全局合计最多 24 KiB。
        </p>
        <label className="flex items-center gap-2 text-b2 text-ink-secondary">
          选择项目{' '}
          <select
            aria-label="选择项目约束"
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
          >
            <option value="">请选择项目</option>
            {settings.projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        {settings.projects.some((project) => project.id === projectId) ? (
          // key 带上 globalRules：全局约束一变就得重读项目约束（合计上限受它影响）——
          // 靠重挂重置编辑器状态（view / 草稿 / 提示），不再在 effect 里同步 setView(null)
          <ProjectRulesEditor
            key={JSON.stringify([projectId, settings.globalRules])}
            projectId={projectId}
          />
        ) : null}
      </div>
    </div>
  )
}
