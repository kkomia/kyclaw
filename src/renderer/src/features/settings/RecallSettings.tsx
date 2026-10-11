import { cn } from '@renderer/components/ui/cn'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Switch } from '@renderer/components/ui/switch'
import { unwrapIpcError } from '@renderer/lib/ipc-error'
import { fetchRecallStatus } from '@renderer/lib/memory-api'
import { useSettingsStore } from '@renderer/lib/settings-store'
import type { RecallStatus } from '@shared/memory'
import type { ProviderKeyState } from '@shared/providers'
import { SEMANTIC_RECALL_PRESET } from '@shared/settings'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { recallStatusText } from './status-text'

/**
 * 设置页「记忆」栏的语义召回组（round 28 模块 3）：长期记忆的开关与嵌入服务。
 *
 * 分工（与「追踪」栏同一套）：开关 + 服务地址/模型是普通设置，经 settings:update 落 settings.json；
 * API Key 只经 memory:set-embedding-key 写方向过一次（主进程 safeStorage 落 secrets.json），
 * 读回来只有"有没有 / 要不要重录"。
 *
 * 地址与模型**预置**成 SiliconFlow 的免费嵌入档（缺省值，见 shared/settings 的
 * SEMANTIC_RECALL_PRESET）：用户只要贴一把 key 就能用；想换服务直接改这两个字段。
 * Key 字段旁的「获取 API Key」是功能性入口（系统浏览器打开预置服务商的 key 页）——
 * 壳层已有处置（main/window.ts 的 setWindowOpenHandler → shell.openExternal），这里就是普通外链。
 *
 * 生效时机：装配在 agent 服务启动时做一次 —— **改这一栏要重启应用才生效**，所以状态行说的是
 * "本次运行开没开"（recallStatusText 的规则：设置值与运行事实不一致时由设置值说话）。
 *
 * UI 从简：不放解释性小字；三项只在开关打开时出现。将来 3B 的「本地模型」组与来源切换
 * （`source: 'localEngine'`）加进来时，这一层只多一组控件，字段形状不动。
 */
interface Draft {
  baseUrl: string
  model: string
  key: string
}

function messageOf(error: unknown): string {
  // 展示前统一剥 IPC 包装（`Error invoking remote method …` 不再露给用户）
  return unwrapIpcError(error)
}

/** 读一次本次运行的召回状态（挂载时、保存/清密钥之后都走它） */
function useRecallStatus(): {
  status: RecallStatus | null
  error: string | undefined
  refresh: () => Promise<void>
} {
  const [status, setStatus] = useState<RecallStatus | null>(null)
  const [error, setError] = useState<string | undefined>(undefined)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setStatus(await fetchRecallStatus())
    } catch (caught) {
      setError(messageOf(caught))
    }
  }, [])

  useEffect(() => {
    let alive = true
    fetchRecallStatus().then(
      (next) => {
        if (alive) setStatus(next)
      },
      (caught: unknown) => {
        if (alive) setError(messageOf(caught))
      }
    )
    return () => {
      alive = false
    }
  }, [])

  return { status, error, refresh }
}

/** 一行状态文字（设置页与记忆页共用）：说清"本次运行开没开" */
export function RecallStatusLine({ className }: { className?: string }): React.JSX.Element {
  const enabled = useSettingsStore((state) => state.settings.semanticRecall.enabled)
  const { status, error } = useRecallStatus()

  return (
    <p
      data-testid="recall-status"
      className={cn('text-b2 text-ink-secondary', className)}
      title={error}
    >
      长期记忆（语义召回）：{error === undefined ? recallStatusText(status, enabled) : error}
    </p>
  )
}

export function RecallSettings(): React.JSX.Element {
  const settings = useSettingsStore((state) => state.settings.semanticRecall)
  const saveSemanticRecall = useSettingsStore((state) => state.saveSemanticRecall)

  const { status, error: statusError, refresh } = useRecallStatus()
  const [draft, setDraft] = useState<Draft | undefined>(undefined)
  const [keyState, setKeyState] = useState<ProviderKeyState | null>(null)
  const [pending, setPending] = useState<'saving' | 'clearing' | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)

  const memoryApi = window.kyclaw?.memory

  useEffect(() => {
    const api = memoryApi
    if (!api) return
    let alive = true
    api.embeddingKeyState().then(
      (next) => {
        if (alive) setKeyState(next)
      },
      (caught: unknown) => {
        if (alive) setError(messageOf(caught))
      }
    )
    return () => {
      alive = false
    }
    // memoryApi 是 preload 注入的常量桥；重挂一次读一次即可
  }, [memoryApi])

  /**
   * 表单值 = 草稿（用户改过就是它）或落盘值；落盘值为空（还没配过）时**先按预置填**：
   * 用户只要贴一把 key 点保存，预置的地址与模型就一并落盘（这两项不必手填）。
   * 用户改过就按用户的来——保存写下去的就是表单里看到的。
   */
  const current: Draft = useMemo(
    () =>
      draft ?? {
        baseUrl: settings.baseUrl.trim() === '' ? SEMANTIC_RECALL_PRESET.baseUrl : settings.baseUrl,
        model: settings.model.trim() === '' ? SEMANTIC_RECALL_PRESET.model : settings.model,
        key: ''
      },
    [draft, settings.baseUrl, settings.model]
  )

  const patchDraft = (patch: Partial<Draft>): void => {
    setDraft({ ...current, ...patch })
  }

  const save = useCallback(async (): Promise<void> => {
    const baseUrl = current.baseUrl.trim()
    const model = current.model.trim()
    const key = current.key.trim()

    setError(undefined)
    setPending('saving')
    try {
      await saveSemanticRecall({ baseUrl, model })
      if (key.length > 0) {
        if (!memoryApi) throw new Error('记忆通道不可用（window.kyclaw 缺失），密钥没有保存')
        await memoryApi.setEmbeddingKey(key)
        setKeyState(await memoryApi.embeddingKeyState())
      }
      setDraft(undefined)
      await refresh()
    } catch (caught) {
      setError(messageOf(caught))
    } finally {
      setPending(undefined)
    }
  }, [current, memoryApi, refresh, saveSemanticRecall])

  const clearKey = useCallback(async (): Promise<void> => {
    if (!memoryApi) {
      setError('记忆通道不可用（window.kyclaw 缺失），密钥没有清除')
      return
    }
    setPending('clearing')
    setError(undefined)
    try {
      setKeyState(await memoryApi.clearEmbeddingKey())
    } catch (caught) {
      setError(messageOf(caught))
    } finally {
      setPending(undefined)
    }
  }, [memoryApi])

  const toggle = (next: boolean): void => {
    setError(undefined)
    saveSemanticRecall({ enabled: next }).catch((caught: unknown) => setError(messageOf(caught)))
  }

  const busy = pending !== undefined

  return (
    <div data-testid="recall-settings" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-b2 text-ink">长期记忆（语义召回）</span>
        <Switch
          checked={settings.enabled}
          label="长期记忆（语义召回）"
          data-testid="recall-enabled"
          disabled={busy}
          onCheckedChange={toggle}
        />
      </div>

      <p
        data-testid="recall-settings-status"
        className="text-b2 text-ink-secondary"
        title={statusError}
      >
        状态：{statusError === undefined ? recallStatusText(status, settings.enabled) : statusError}
      </p>

      {settings.enabled ? (
        <>
          <label className="flex flex-col gap-1">
            <span className="text-b2 text-ink-secondary">服务地址</span>
            <Input
              data-testid="recall-base-url"
              value={current.baseUrl}
              placeholder={SEMANTIC_RECALL_PRESET.baseUrl}
              disabled={busy}
              onChange={(event) => patchDraft({ baseUrl: event.target.value })}
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-b2 text-ink-secondary">模型</span>
            <Input
              data-testid="recall-model"
              value={current.model}
              placeholder={SEMANTIC_RECALL_PRESET.model}
              disabled={busy}
              onChange={(event) => patchDraft({ model: event.target.value })}
            />
          </label>

          <div className="flex flex-col gap-1">
            <span className="flex items-center justify-between gap-2">
              <label htmlFor="recall-api-key" className="text-b2 text-ink-secondary">
                API Key
              </label>
              {/* 功能性入口（不是解释性小字）：系统浏览器打开预置服务商的 key 页。
                  壳层已有"新窗口一律交给系统浏览器"的处置（main/window.ts 的
                  setWindowOpenHandler → shell.openExternal），所以这里就是一个普通外链。 */}
              <a
                href={SEMANTIC_RECALL_PRESET.keyUrl}
                target="_blank"
                rel="noreferrer"
                data-testid="recall-key-link"
                className="text-b2 text-accent-text underline"
              >
                获取 API Key
              </a>
            </span>
            <Input
              id="recall-api-key"
              type="password"
              autoComplete="off"
              data-testid="recall-api-key"
              value={current.key}
              placeholder={keyState?.hasKey ? '已保存；要换就填新的' : '粘贴 API Key'}
              disabled={busy}
              onChange={(event) => patchDraft({ key: event.target.value })}
            />
          </div>

          {keyState?.needsReentry === true ? (
            <p data-testid="recall-reentry" className="text-c1 text-ink-secondary">
              已存的密钥在这台机器上读不到，请重新录入。
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-3">
            <Button
              size="sm"
              data-testid="recall-save"
              loading={pending === 'saving'}
              disabled={busy && pending !== 'saving'}
              onClick={() => void save()}
            >
              保存
            </Button>
            {keyState?.hasKey === true ? (
              <Button
                size="sm"
                variant="ghost"
                data-testid="recall-clear-key"
                loading={pending === 'clearing'}
                disabled={busy && pending !== 'clearing'}
                onClick={() => void clearKey()}
              >
                清除密钥
              </Button>
            ) : null}
          </div>
        </>
      ) : null}

      {error === undefined ? null : (
        <p data-testid="recall-error" className="text-c1 text-danger">
          {error}
        </p>
      )}
    </div>
  )
}
