import { unwrapIpcError } from '@renderer/lib/ipc-error'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Switch } from '@renderer/components/ui/switch'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { LANGFUSE_PRESET, type LangfuseSettings } from '@shared/settings'
import type { LangfuseState } from '@shared/ipc'
import { langfuseStatusText } from './status-text'

/**
 * 设置页「追踪」组（T17）：Langfuse 的**显式开关** + 服务地址 / 代理 / 公私钥。
 *
 * 分工（与「模型」栏同一套）：开关、地址与代理是普通设置，经 settings:update 落 settings.json；
 * 公私钥只经 telemetry:set-langfuse-keys 写方向过一次（主进程加密落 secrets.json），
 * 读回来只有"有没有 / 要不要重录"。开关关着 = 一律不发（判定在 main/telemetry.ts）；
 * 开关开着也要三项（地址 + 两把密钥）配齐才导出（缺一不导出、不报错）。
 *
 * round 86（用户口径 010）：**开/关是显式的**。旧口径是"地址留空 = 关闭"那种隐式语义，
 * 现在由这一枚开关说了算（地址留空只是"没配"）。开关与「记忆」栏同一手法：就地落盘（不留草稿），
 * 状态行跟着设置值说话；老设置没有这一位时按"没显式关过 = 开着"迁移（main/settings.ts），
 * 所以升级不会把正在上报的用户静默关掉。
 *
 * round 67：地址预填用户现用的那台自建实例（LANGFUSE_PRESET，可随手改成云版/别的实例）；
 * 代理留空 = 直连（主进程会用 HTTPS_PROXY / HTTP_PROXY 等环境变量兜底，所以这栏空着不等于没代理）。
 *
 * 生效时机：exporter 随 agent 服务一起建 —— **改配置要重启应用才生效**，
 * 所以状态行说的是"已开启 / 已配置，重启应用后开启 / 未开启 / 已关闭"（不编造当前会话没发生的事）。
 * 「清除密钥」只清密钥（要连上报一起停就关开关）。文案规则在 status-text.ts。
 *
 * 用户口径 010：默认只露一行状态（+ 开关 + 「配置」）+ 说明，地址 / 代理 / 公私钥 / 保存 /
 * 清除密钥全部收进「配置」后面的展开区 —— 要配的时候再展开，不再平铺在页面主体上。
 * 保存与清除都给一行结果反馈。
 */
interface Draft {
  endpoint: string
  proxyUrl: string
  publicKey: string
  secretKey: string
}

function messageOf(error: unknown): string {
  // round 25：展示前统一剥 IPC 包装（`Error invoking remote method …` 不再露给用户）
  return unwrapIpcError(error)
}

export function TracingSettings(): React.JSX.Element {
  const storedEndpoint = useSettingsStore((sample) => sample.settings.langfuse.endpoint)
  const storedProxyUrl = useSettingsStore((sample) => sample.settings.langfuse.proxyUrl)
  /** 显式开关（round 86）：设置值就是真相，与「记忆」栏同一口径（状态行也按它说话） */
  const enabled = useSettingsStore((sample) => sample.settings.langfuse.enabled)
  const saveLangfuse = useSettingsStore((sample) => sample.saveLangfuse)

  const [state, setState] = useState<LangfuseState | null>(null)
  const [draft, setDraft] = useState<Draft | undefined>(undefined)
  const [pending, setPending] = useState<'saving' | 'clearing' | 'toggling' | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  /** 配置区的展开状态：默认收起（010 —— 默认只露状态行） */
  const [expanded, setExpanded] = useState(false)
  /** 上一次动作的结果（保存 / 清除密钥都在这行说话） */
  const [notice, setNotice] = useState('')

  /** 读一次状态（挂载时、保存/清除之后都走它） */
  const refreshState = useCallback(async (): Promise<void> => {
    try {
      const next = await window.kyclaw?.telemetry?.langfuseState()
      if (next) setState(next)
    } catch (caught) {
      // 读不到状态只影响状态行与"已配置"标记，不该拦住整栏
      setError(messageOf(caught))
    }
  }, [])

  useEffect(() => {
    // 挂载时先拉一次（与主进程同一份口径：落盘地址 + 密钥状态 + 本次运行有没有挂上）
    const api = window.kyclaw?.telemetry
    if (!api) return
    let alive = true
    void api
      .langfuseState()
      .then((next) => {
        if (alive) setState(next)
      })
      .catch((caught: unknown) => {
        if (alive) setError(messageOf(caught))
      })
    return () => {
      alive = false
    }
  }, [])

  /** 表单值 = 草稿（用户改过就是它）或落盘值（没改过就是设置的真相） */
  const current: Draft = useMemo(
    () =>
      draft ?? {
        endpoint: storedEndpoint,
        proxyUrl: storedProxyUrl,
        publicKey: '',
        secretKey: ''
      },
    [draft, storedEndpoint, storedProxyUrl]
  )

  const patchDraft = (patch: Partial<Draft>): void => {
    setDraft({ ...current, ...patch })
    // 012：输入一动，上一次动作留下的「已保存」就不再描述眼前这份内容
    setNotice('')
  }

  /**
   * **就地落盘**（round 86，与「记忆」栏同一手法）：开关是"要不要发"的显式决定，不该跟地址/
   * 密钥一起攒在一颗「保存」后面（那会让"关掉"也要先点保存）。失败回行内错误，状态行不跟着
   * 撒谎（设置值没变 → 状态行不变）。
   *
   * 一次只写一条：`pending` 要等下一次渲染才生效，连点两下会并发发两次 settings:update ——
   * 用一个 ref 现读的锁把这段串起来（期间开关与「保存」都是 disabled）。
   */
  const writing = useRef(false)
  const writeInPlace = useCallback(
    async (patch: Partial<LangfuseSettings>): Promise<void> => {
      if (writing.current) return
      writing.current = true
      setPending('toggling')
      setError(undefined)
      setNotice('')
      try {
        await saveLangfuse(patch)
      } catch (caught) {
        setError(messageOf(caught))
      } finally {
        writing.current = false
        setPending(undefined)
      }
    },
    [saveLangfuse]
  )
  const toggle = (next: boolean): void => void writeInPlace({ enabled: next })

  const save = useCallback(async (): Promise<void> => {
    const endpoint = current.endpoint.trim()
    const proxyUrl = current.proxyUrl.trim()
    const publicKey = current.publicKey.trim()
    const secretKey = current.secretKey.trim()

    setError(undefined)
    setNotice('')
    // 公私钥要一起填：先判后写，免得"地址存了、密钥报错"的半截动作
    if ((publicKey.length === 0) !== (secretKey.length === 0)) {
      setError('公私钥要一起填；只换地址的话保持两栏空着')
      return
    }

    setPending('saving')
    try {
      await saveLangfuse({ endpoint, proxyUrl })
      if (publicKey.length > 0 && secretKey.length > 0) {
        const api = window.kyclaw?.telemetry
        if (!api) throw new Error('追踪通道不可用（window.kyclaw 缺失），密钥没有保存')
        await api.setLangfuseKeys(publicKey, secretKey)
      }
      // 回到落盘真相：密钥草稿清空（永远不回显），地址与代理以保存后的值为准
      setDraft(undefined)
      await refreshState()
      setNotice('已保存')
    } catch (caught) {
      setError(messageOf(caught))
    } finally {
      setPending(undefined)
    }
  }, [current, refreshState, saveLangfuse])

  const clearKeys = useCallback(async (): Promise<void> => {
    const api = window.kyclaw?.telemetry
    if (!api) {
      setError('追踪通道不可用（window.kyclaw 缺失），密钥没有清除')
      return
    }
    setPending('clearing')
    setError(undefined)
    setNotice('')
    try {
      setState(await api.clearLangfuseKeys())
      setDraft(undefined)
      setNotice('密钥已清除')
    } catch (caught) {
      setError(messageOf(caught))
    } finally {
      setPending(undefined)
    }
  }, [])

  const hasKeys = state !== null && (state.publicKey.hasKey || state.secretKey.hasKey)
  const needsReentry =
    state !== null && (state.publicKey.needsReentry || state.secretKey.needsReentry)
  const busy = pending !== undefined

  return (
    <div data-testid="tracing-settings" className="flex flex-col gap-4">
      <p className="text-b2 text-ink-secondary">把对话过程发送到你的 Langfuse。</p>

      {/* 默认只露这一行：开关 + 状态 + 「配置」入口（010 —— 配置项收进展开区，不平铺在页面上；
          round 86 把这个栏目的开/关做成显式的一枚开关，不再是"地址留空 = 关闭"那种隐式语义） */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Switch
            data-testid="langfuse-enabled"
            label="把对话过程发送到你的 Langfuse"
            checked={enabled}
            disabled={busy}
            onCheckedChange={toggle}
          />
          <p data-testid="langfuse-status" className="text-b2 text-ink-secondary">
            {langfuseStatusText(state, enabled)}
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          data-testid="langfuse-config-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? '收起' : '配置'}
        </Button>
      </div>

      {/* 密钥读不到（换机/迁移）是要用户动手的事：不收进展开区（收起时也看得见） */}
      {needsReentry ? (
        <p data-testid="langfuse-reentry" className="text-c1 text-ink-secondary">
          已存的密钥在这台机器上读不到，请重新录入。
        </p>
      ) : null}

      {expanded ? (
        <>
          <label className="flex flex-col gap-1">
            <span className="text-b2 text-ink-secondary">服务地址</span>
            <Input
              data-testid="langfuse-endpoint"
              value={current.endpoint}
              placeholder={LANGFUSE_PRESET.endpoint}
              disabled={busy}
              onChange={(event) => patchDraft({ endpoint: event.target.value })}
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-b2 text-ink-secondary">代理（可选）</span>
            <Input
              autoComplete="off"
              data-testid="langfuse-proxy"
              value={current.proxyUrl}
              placeholder="http://127.0.0.1:7890"
              disabled={busy}
              onChange={(event) => patchDraft({ proxyUrl: event.target.value })}
            />
          </label>

          <p className="text-c1 text-ink-secondary">
            开关关掉后不再发送；地址与密钥配齐（并重启应用）才会真的发。代理留空 = 直连（也可以用
            HTTPS_PROXY / HTTP_PROXY 环境变量）。
          </p>

          <label className="flex flex-col gap-1">
            <span className="text-b2 text-ink-secondary">Public Key</span>
            <Input
              autoComplete="off"
              data-testid="langfuse-public-key"
              value={current.publicKey}
              placeholder={state?.publicKey.hasKey ? '已保存；要换就填新的' : '粘贴 Public Key'}
              disabled={busy}
              onChange={(event) => patchDraft({ publicKey: event.target.value })}
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-b2 text-ink-secondary">Secret Key</span>
            <Input
              type="password"
              autoComplete="off"
              data-testid="langfuse-secret-key"
              value={current.secretKey}
              placeholder={state?.secretKey.hasKey ? '已保存；要换就填新的' : '粘贴 Secret Key'}
              disabled={busy}
              onChange={(event) => patchDraft({ secretKey: event.target.value })}
            />
          </label>

          <div className="flex flex-wrap items-center gap-3">
            <Button
              size="sm"
              data-testid="langfuse-save"
              loading={pending === 'saving'}
              disabled={busy && pending !== 'saving'}
              onClick={() => void save()}
            >
              保存
            </Button>
            {hasKeys ? (
              <Button
                size="sm"
                variant="ghost"
                data-testid="langfuse-clear-keys"
                loading={pending === 'clearing'}
                disabled={busy && pending !== 'clearing'}
                onClick={() => void clearKeys()}
              >
                清除密钥
              </Button>
            ) : null}
          </div>

          {/* 012：保存 / 清除密钥都要有结果反馈（失败的原因在下面的错误行） */}
          {notice === '' ? null : (
            <p data-testid="langfuse-notice" role="status" className="text-c1 text-ink-secondary">
              {notice}
            </p>
          )}
        </>
      ) : null}

      {error === undefined ? null : (
        <p data-testid="langfuse-error" className="text-c1 text-danger">
          {error}
        </p>
      )}
    </div>
  )
}
