import { unwrapIpcError } from '@renderer/lib/ipc-error'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { LANGFUSE_PRESET } from '@shared/settings'
import type { LangfuseState } from '@shared/ipc'
import { langfuseStatusText } from './status-text'

/**
 * 设置页「追踪」组（T17）：Langfuse 开关，**默认关**。
 *
 * 分工（与「模型」栏同一套）：服务地址与代理是普通设置，经 settings:update 落 settings.json；
 * 公私钥只经 telemetry:set-langfuse-keys 写方向过一次（主进程加密落 secrets.json），
 * 读回来只有"有没有 / 要不要重录"。三项（地址 + 两把密钥）配齐 = 开启导出（缺一不导出、不报错）。
 *
 * round 67：地址预填用户现用的那台自建实例（LANGFUSE_PRESET，可随手改成云版/别的实例）；
 * 代理留空 = 直连（主进程会用 HTTPS_PROXY / HTTP_PROXY 等环境变量兜底，所以这栏空着不等于没代理）。
 *
 * 生效时机：exporter 随 agent 服务一起建 —— **改配置要重启应用才生效**，
 * 所以状态行说的是"已开启 / 已配置，重启应用后开启 / 未开启"（不编造当前会话没发生的事）。
 * 清空服务地址保存 = 关闭（想连密钥一起清就走"清除密钥"）。文案规则在 status-text.ts。
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
  const saveLangfuse = useSettingsStore((sample) => sample.saveLangfuse)

  const [state, setState] = useState<LangfuseState | null>(null)
  const [draft, setDraft] = useState<Draft | undefined>(undefined)
  const [pending, setPending] = useState<'saving' | 'clearing' | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)

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
  }

  const save = useCallback(async (): Promise<void> => {
    const endpoint = current.endpoint.trim()
    const proxyUrl = current.proxyUrl.trim()
    const publicKey = current.publicKey.trim()
    const secretKey = current.secretKey.trim()

    setError(undefined)
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
    try {
      setState(await api.clearLangfuseKeys())
      setDraft(undefined)
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
      <p className="text-b2 text-ink-secondary">把对话过程发送到你的 Langfuse，默认关闭。</p>

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
        地址留空 = 关闭追踪；代理留空 = 直连（也可以用 HTTPS_PROXY / HTTP_PROXY
        环境变量）。改完要重启应用才生效。
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

      {needsReentry ? (
        <p data-testid="langfuse-reentry" className="text-c1 text-ink-secondary">
          已存的密钥在这台机器上读不到，请重新录入。
        </p>
      ) : null}

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

      <p data-testid="langfuse-status" className="text-b2 text-ink-secondary">
        {langfuseStatusText(state)}
      </p>

      {error === undefined ? null : (
        <p data-testid="langfuse-error" className="text-c1 text-danger">
          {error}
        </p>
      )}
    </div>
  )
}
