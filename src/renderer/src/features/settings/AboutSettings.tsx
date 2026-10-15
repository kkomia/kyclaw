import { unwrapIpcError } from '@renderer/lib/ipc-error'
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { cn } from '@renderer/components/ui/cn'
import { Input } from '@renderer/components/ui/input'
import { useSettingsStore } from '@renderer/lib/settings-store'
import type { UpdateState } from '@shared/ipc'
import { updateStatusText } from './status-text'

/**
 * 设置页「关于」组（T17；round 63 起可以在这里换更新源；0.1.1 起显示这一版的更新内容）：
 * 当前版本 + 手动"检查更新" + 一行状态 + 更新内容 + 更新源。
 *
 * 分工：
 *   - 状态由主进程推（`updates:onStateChanged`），挂载时先拉一次（推送只对已在听的渲染端有效）；
 *   - "检查更新" 走 `updates:check`：等"检查"这一步落地（下载在后台继续，进度继续推）；
 *   - 没配更新源时按钮禁用、状态写「未配置更新源」——**不报错、不弹窗、不发网络请求**
 *     （开发态与未配置的默认路径）；
 *   - 有新版本时按钮变「重启并安装」：安装是用户点的动作（主进程 `autoInstallOnAppQuit = false`），
 *     检出后自动下载、进度显示在状态行里。
 *   - round 63：更新源是普通设置（settings:update），保存后**主进程当场重配更新器并广播新状态**——
 *     这里不用自己刷新状态；留空 = 用打包时烘焙的那个源（它的地址由主进程给成占位提示）。
 *     非空必须是完整的 http(s) 地址，填错只挡保存（不写盘、不弹窗）。
 *   - 0.1.1：新版本的**更新内容**（源上渠道 yml 的 releaseNotes/releaseName/releaseDate）显示在
 *     状态行下面，只显示当前这一版的那一份，缺了整块不出现（更新照旧）。纯文本渲染：源上给的
 *     HTML/脚本按字面量显示，不插 DOM、不拉远程图片。
 *
 * 全部文案零 emoji、不写后端实现、不用黑描边（状态就是一行普通文字，见雷点 v1）；
 * 文案规则在 status-text.ts（独立文件，顺带过 react-refresh 的"只导出组件"口径）。
 */
function messageOf(error: unknown): string {
  // round 25：展示前统一剥 IPC 包装（`Error invoking remote method …` 不再露给用户）
  return unwrapIpcError(error)
}

/** 非空就必须是完整的 http(s) 地址（真的解析一次：`http://` 这类半截串过不了这里） */
function updateUrlProblem(value: string): string | undefined {
  const text = value.trim()
  if (text.length === 0) return undefined
  try {
    const parsed = new URL(text)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return undefined
  } catch {
    // 半截地址与协议不对落到同一句（不给用户区分，两种都是"用不了"）
  }
  return '地址无效'
}

/** 超过这个长度/行数才给「展开」（阈值以下直接全显，不多给一个要点的东西） */
const NOTES_LONG_CHARS = 240
const NOTES_LONG_LINES = 6

interface ReleaseView {
  /** 发行名（源上没给就是「更新内容」） */
  title: string
  notes: string
  /** 发行日期（源上没给就没有） */
  date?: string
}

/** 只有"有新版本"的三个相位（可用/下载中/已下载）有这一份，且都是同一个版本的；缺日志 = 不显示 */
function releaseView(status: UpdateState['status']): ReleaseView | undefined {
  switch (status.phase) {
    case 'available':
    case 'downloading':
    case 'downloaded': {
      const notes = status.notes?.trim() ?? ''
      if (notes.length === 0) return undefined
      const name = status.releaseName?.trim() ?? ''
      const date = status.releaseDate?.trim() ?? ''
      return {
        title: name.length > 0 ? name : '更新内容',
        notes,
        ...(date.length === 0 ? {} : { date: releaseDateText(date) })
      }
    }
    default:
      return undefined
  }
}

/** 发行日期取到"年月日 时分"（本地时间）；解析不出来的串原样给（不吞源上的日期） */
function releaseDateText(raw: string): string {
  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) return raw
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}` +
    ` ${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`
  )
}

export function AboutSettings(): React.JSX.Element {
  const storedUpdateUrl = useSettingsStore((sample) => sample.settings.updateUrl)

  const [state, setState] = useState<UpdateState | null>(null)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  /** 更新源草稿：用户改过就是它，没改过显示落盘值（与「追踪」栏同一套） */
  const [draft, setDraft] = useState<string | undefined>(undefined)
  const [saving, setSaving] = useState(false)
  /** 上一次保存的结果（012 用户口径：点保存要有明确反馈） */
  const [notice, setNotice] = useState('')
  /** 保存被挡下的原因（就一句人话，改一下就清掉） */
  const [problem, setProblem] = useState<string | undefined>(undefined)
  /** 收起态用**内容本身**当标记：新版本推来时内容不一样，自然回到收起态（不必另写一个效应） */
  const [expandedNotes, setExpandedNotes] = useState<string | undefined>(undefined)

  useEffect(() => {
    const api = window.kyclaw?.updates
    if (!api) return
    let alive = true
    void api
      .state()
      .then((next) => {
        if (alive) setState(next)
      })
      .catch((caught: unknown) => {
        if (alive) setError(messageOf(caught))
      })
    const unsubscribe = api.onStateChanged((next) => setState(next))
    return () => {
      alive = false
      unsubscribe()
    }
  }, [])

  const check = useCallback(async (): Promise<void> => {
    const api = window.kyclaw?.updates
    if (!api) {
      setError('更新通道不可用（window.kyclaw 缺失），没法检查更新')
      return
    }
    setChecking(true)
    setError(undefined)
    try {
      setState(await api.check())
    } catch (caught) {
      setError(messageOf(caught))
    } finally {
      setChecking(false)
    }
  }, [])

  const install = useCallback(async (): Promise<void> => {
    const api = window.kyclaw?.updates
    if (!api) return
    try {
      await api.install()
    } catch (caught) {
      setError(messageOf(caught))
    }
  }, [])

  const urlValue = draft ?? storedUpdateUrl

  const saveUrl = useCallback(async (): Promise<void> => {
    const found = updateUrlProblem(urlValue)
    if (found !== undefined) {
      setProblem(found)
      return
    }
    setProblem(undefined)
    setNotice('')
    setError(undefined)
    setSaving(true)
    try {
      // 直接走 IPC（与「约束」/「工作区」栏同一套）：store 的 update 把落盘失败吞成一条日志
      // （见 lib/settings-store.ts），这一栏要能把失败说出来（012）
      const api = window.kyclaw?.settings
      if (!api) throw new Error('设置通道不可用，未保存')
      useSettingsStore.setState({ settings: await api.update({ updateUrl: urlValue.trim() }) })
      // 回到落盘真相：草稿清掉，输入框跟着设置走（主进程随后会推一次新的更新状态）
      setDraft(undefined)
      setNotice('已保存')
    } catch (caught) {
      setError(messageOf(caught))
    } finally {
      setSaving(false)
    }
  }, [urlValue])

  const downloaded = state?.status.phase === 'downloaded'
  const disabled = state === null || !state.configured
  /** 这一版有没有更新内容可看（没有 = 那一块整块不出现，按钮/安装都不受影响） */
  const release = state === null ? undefined : releaseView(state.status)
  const releaseNotes = release?.notes
  const longNotes =
    releaseNotes !== undefined &&
    (releaseNotes.length > NOTES_LONG_CHARS || releaseNotes.split('\n').length > NOTES_LONG_LINES)
  const notesExpanded = releaseNotes !== undefined && expandedNotes === releaseNotes

  return (
    <div data-testid="about-settings" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <span data-testid="about-version" className="text-b2 text-ink">
          版本 {state?.currentVersion ?? '—'}
        </span>
        <span className="min-w-2 flex-1" />
        {downloaded ? (
          <Button size="sm" data-testid="about-install" onClick={() => void install()}>
            重启并安装
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          data-testid="about-check"
          loading={checking}
          disabled={disabled}
          onClick={() => void check()}
        >
          检查更新
        </Button>
      </div>

      <p data-testid="about-update-status" className="text-b2 text-ink-secondary">
        {updateStatusText(state)}
      </p>

      {release === undefined ? null : (
        <div data-testid="about-release" className="flex flex-col gap-2">
          <div className="flex flex-wrap items-baseline gap-2">
            <span data-testid="about-release-name" className="text-b2 text-ink">
              {release.title}
            </span>
            {release.date === undefined ? null : (
              <span data-testid="about-release-date" className="text-c1 text-ink-secondary">
                {release.date}
              </span>
            )}
          </div>
          {/* 纯文本渲染（文本子节点，不是 innerHTML）：源上的 HTML/图片/脚本按字面显示，不执行也不外取 */}
          <p
            data-testid="about-release-notes"
            className={cn(
              'rounded-control bg-surface px-2 py-1.5 text-c1 whitespace-pre-wrap text-ink-secondary [overflow-wrap:anywhere]',
              longNotes && !notesExpanded ? 'max-h-24 overflow-hidden' : 'max-h-64 overflow-auto'
            )}
          >
            {releaseNotes}
          </p>
          {longNotes ? (
            <div>
              <Button
                size="sm"
                variant="ghost"
                data-testid="about-release-toggle"
                onClick={() => setExpandedNotes(notesExpanded ? undefined : releaseNotes)}
              >
                {notesExpanded ? '收起' : '展开'}
              </Button>
            </div>
          ) : null}
        </div>
      )}

      <div className="flex flex-col gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-b2 text-ink-secondary">更新源</span>
          <Input
            data-testid="about-update-url"
            value={urlValue}
            placeholder={state?.builtinUrl ?? ''}
            aria-invalid={problem !== undefined || undefined}
            disabled={saving}
            className={cn(problem !== undefined && 'border-danger')}
            onChange={(event) => {
              setDraft(event.target.value)
              setProblem(undefined)
              setNotice('')
            }}
          />
        </label>

        {problem === undefined ? null : (
          <p data-testid="about-update-url-error" className="text-c1 text-danger">
            {problem}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Button
            size="sm"
            data-testid="about-update-url-save"
            loading={saving}
            onClick={() => void saveUrl()}
          >
            保存
          </Button>
          {notice === '' ? null : (
            <span
              data-testid="about-update-url-notice"
              role="status"
              className="text-c1 text-ink-secondary"
            >
              {notice}
            </span>
          )}
        </div>
      </div>

      {error === undefined ? null : (
        <p data-testid="about-error" className="text-c1 text-danger">
          {error}
        </p>
      )}
    </div>
  )
}
