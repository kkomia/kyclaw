import { useEffect, useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { unwrapIpcError } from '@renderer/lib/ipc-error'
import { rulesByteLength, rulesTextProblem } from '@shared/rules'
import type { ProjectRulesView } from '@shared/rules-ipc'

function RuleEditor({
  scope,
  text,
  pending,
  onChange,
  onSave
}: {
  scope: 'global' | 'project'
  text: string
  pending: boolean
  onChange: (text: string) => void
  onSave: (text: string) => void
}): React.JSX.Element {
  const problem = rulesTextProblem(text, scope)
  return (
    <div className="flex flex-col gap-3">
      <textarea
        aria-label={scope === 'global' ? '全局规矩' : '项目规矩'}
        value={text}
        disabled={pending}
        onChange={(event) => onChange(event.target.value)}
        rows={10}
        className="rounded-lg border border-border bg-transparent p-3 text-b2 text-ink"
      />
      <p>{rulesByteLength(text)} / 16384 字节（UTF-8）</p>
      {problem ? <p role="alert">{problem.message}</p> : null}
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
  const [message, setMessage] = useState('')
  // preload 注入的常量桥：通道缺失在"读之前"就能确定，渲染期直接派生，不进 effect 同步 setState。
  // 项目 / 全局规矩变化由外层 key 重挂重置编辑器（见 RulesSettings 里 ProjectRulesEditor 的 key）。
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
          setMessage('')
        }
      },
      (error: unknown) => {
        if (alive) setMessage(unwrapIpcError(error))
      }
    )
    return () => {
      alive = false
    }
  }, [projectId])
  const save = async (value: string): Promise<void> => {
    setPending(true)
    try {
      const api = window.kyclaw?.projects
      if (!api?.saveRules) throw new Error('项目规矩通道不可用，未保存')
      const result = await api.saveRules(projectId, value)
      if (!result.ok) {
        setMessage(result.diagnostics.map((item) => item.message).join('；'))
        return
      }
      setView(result.view)
      setText(result.view.text)
      setMessage('已保存')
    } catch (error) {
      setMessage(unwrapIpcError(error))
    } finally {
      setPending(false)
    }
  }
  return (
    <div className="flex flex-col gap-3">
      {view ? (
        <>
          <p>来源：{view.source}</p>
          <p>
            {!view.projectIncluded
              ? '项目规矩不生效：未加载或合并超限。'
              : view.processorRegistered
                ? '加载条件满足：仅绑定此项目的会话下一轮采用；本轮明确要求优先。'
                : '已可编辑保存，聊天规则处理器尚未接线，当前不生效。'}
          </p>
          {view.diagnostics.map((item, index) => (
            <p role="alert" key={index}>
              {item.message}
            </p>
          ))}
          <RuleEditor
            scope="project"
            text={text}
            pending={pending}
            onChange={setText}
            onSave={(value) => void save(value)}
          />
        </>
      ) : (
        <p>正在读取项目规矩…</p>
      )}
      {channelMissing ? <p role="status">项目规矩通道不可用</p> : null}
      {message ? <p role="status">{message}</p> : null}
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
  const [registered, setRegistered] = useState<boolean | null>(null)
  const [statusError, setStatusError] = useState('')
  const [statusRevision, setStatusRevision] = useState(0)
  useEffect(() => {
    let alive = true
    let generation = 0
    const refresh = (): void => {
      const request = ++generation
      const api = window.kyclaw?.projects
      if (!api?.rulesStatus) {
        setRegistered(null)
        setStatusError('规则状态通道不可用，无法确认当前运行是否注册处理器。')
        return
      }
      api.rulesStatus().then(
        (status) => {
          if (alive && request === generation) {
            setRegistered(status.processorRegistered)
            setStatusError('')
          }
        },
        (error: unknown) => {
          if (alive && request === generation) {
            setRegistered(null)
            setStatusError(unwrapIpcError(error))
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
  }, [statusRevision])
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState('')
  const save = async (value: string): Promise<void> => {
    setPending(true)
    try {
      const api = window.kyclaw?.settings
      if (!api) throw new Error('设置通道不可用，未保存')
      const next = await api.update({ globalRules: value })
      useSettingsStore.setState({ settings: next })
      // 落盘后清草稿：text 回到 store 的权威值（= next.globalRules）；失败路径不清，草稿留着
      setDraft(null)
      setMessage('已保存')
    } catch (error) {
      setMessage(unwrapIpcError(error))
    } finally {
      setPending(false)
    }
  }
  return (
    <div className="flex flex-col gap-4" data-testid="settings-group-rules">
      <p>
        我的规矩是普通偏好，不是硬权限。应用硬约束最高；项目在同事项上覆盖全局默认，本轮明确要求覆盖普通偏好。规矩不会改变权限、Plan
        模式或审批。
      </p>
      <h2>全局规矩</h2>
      <p>来源：应用设置 globalRules。</p>
      <p role="status">
        {registered === null
          ? '正在确认规则处理器注册状态；保存仅表示持久化，不代表聊天已采用。'
          : registered
            ? '规则处理器已注册；保存后下一轮读取全局偏好，本轮明确要求优先。'
            : '当前运行尚未注册规则处理器，已保存内容暂不用于聊天。'}
      </p>
      {statusError ? <p role="alert">{statusError}</p> : null}
      <Button
        variant="ghost"
        size="sm"
        className="self-start"
        onClick={() => {
          setRegistered(null)
          setStatusRevision((value) => value + 1)
        }}
      >
        刷新规则状态
      </Button>
      <RuleEditor
        scope="global"
        text={text}
        pending={pending}
        onChange={setDraft}
        onSave={(value) => void save(value)}
      />
      {message ? <p role="status">{message}</p> : null}
      <h2>项目规矩</h2>
      <label>
        选择项目{' '}
        <select
          aria-label="选择项目规矩"
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
      <p>
        只读取已绑定项目的 .kyclaw/rules.md，不读取默认工作区或父目录；全局与项目合计最多 24 KiB。
      </p>
      {settings.projects.some((project) => project.id === projectId) ? (
        // key 带上 globalRules：全局规矩一变就得重读项目规矩（合计上限受它影响）——
        // 靠重挂重置编辑器状态（view / 草稿 / 提示），不再在 effect 里同步 setView(null)
        <ProjectRulesEditor
          key={JSON.stringify([projectId, settings.globalRules])}
          projectId={projectId}
        />
      ) : null}
    </div>
  )
}
