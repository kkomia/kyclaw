import { unwrapIpcError } from '@renderer/lib/ipc-error'
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Chip } from '@renderer/components/ui/chip'
import { Input } from '@renderer/components/ui/input'
import { useSettingsStore } from '@renderer/lib/settings-store'
import type { ConnectionTestResult } from '@shared/ipc'
import {
  newCustomProvider,
  providerConfigProblems,
  providerFromPreset,
  providerLabel,
  providerPreset,
  PROVIDER_PRESETS,
  withDefaultProvider,
  type ProviderConfig,
  type ProviderKeyState,
  type ProviderType
} from '@shared/providers'

/**
 * 设置页「模型」组（T8）：provider 配置 + 密钥 + 测试连接 + 默认通道。
 *
 * 分工：
 *   - provider 配置（id/type/baseUrl/model/isDefault）落 settings.json，经 `saveProviders` 走 settings:update；
 *   - 密钥只在**写**的方向上经过渲染端（用户输入 → settings:set-provider-key），主进程加密后落
 *     safeStorage 密文；读回来的只有"已配置 / 需要重新录入"两个状态，界面永远不回显明文；
 *   - "测试连接"由主进程发一条最小请求（见 main/connection-test.ts），这里只展示延迟或错误文案。
 *
 * 半截配置（缺模型名 / 缺 Base URL / 缺密钥）行内给具体提示——文案与模型解析处是同一句
 * （shared/providers.providerConfigProblems），不静默回落 mock。
 */
interface Draft {
  model: string
  baseUrl: string
  /** 待写入的新密钥；保存成功后立刻清空（已存的密钥不回显） */
  key: string
}

type Pending = 'saving' | 'testing'

function draftOf(provider: ProviderConfig): Draft {
  return { model: provider.model, baseUrl: provider.baseUrl ?? '', key: '' }
}

function messageOf(error: unknown): string {
  // round 25：展示前统一剥 IPC 包装（`Error invoking remote method …` 不再露给用户）
  return unwrapIpcError(error)
}

/** 删掉 record 里的一条（草稿/状态/结果都是按 provider id 存的） */
function withoutKey<T>(record: Record<string, T>, id: string): Record<string, T> {
  const next = { ...record }
  delete next[id]
  return next
}

/** 密钥状态还没读到时的显示：不猜"未配置"（免得一闪而过的误报） */
function keyStatusText(state: ProviderKeyState | undefined): string {
  if (!state) return '读取中…'
  if (state.needsReentry) return '需要重新录入'
  return state.hasKey ? '已配置' : '未配置'
}

export function ModelSettings(): React.JSX.Element {
  const providers = useSettingsStore((state) => state.settings.providers)
  const saveProviders = useSettingsStore((state) => state.saveProviders)
  const removeProvider = useSettingsStore((state) => state.removeProvider)

  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [keyStates, setKeyStates] = useState<Record<string, ProviderKeyState>>({})
  const [pending, setPending] = useState<Record<string, Pending | undefined>>({})
  const [results, setResults] = useState<Record<string, ConnectionTestResult | undefined>>({})
  const [errors, setErrors] = useState<Record<string, string | undefined>>({})
  const [pageError, setPageError] = useState<string | undefined>(undefined)

  // id 集合变了（增/删 provider）就重新读密钥状态；改配置不影响状态
  const providerIds = providers.map((provider) => provider.id).join(',')

  const refreshKeyStates = useCallback(async (): Promise<void> => {
    try {
      const states = await window.kyclaw?.settings?.providerKeyStates()
      if (states) setKeyStates(states)
    } catch (error) {
      // 读不到状态只影响"已配置"徽章（显示成未配置），不该拦住整个设置页
      console.error('读取密钥状态失败', error)
    }
  }, [])

  useEffect(() => {
    void refreshKeyStates()
  }, [refreshKeyStates, providerIds])

  const patchDraft = useCallback((provider: ProviderConfig, patch: Partial<Draft>): void => {
    setDrafts((previous) => ({
      ...previous,
      [provider.id]: { ...(previous[provider.id] ?? draftOf(provider)), ...patch }
    }))
  }, [])

  /** 保存一条 provider（配置 + 可选的新密钥）；失败把原因写进行内错误，调用方能据此决定要不要继续 */
  const save = useCallback(
    async (provider: ProviderConfig): Promise<boolean> => {
      const draft = drafts[provider.id] ?? draftOf(provider)
      const next: ProviderConfig = {
        ...provider,
        model: draft.model.trim(),
        baseUrl: provider.type === 'openai-compatible' ? draft.baseUrl.trim() : undefined
      }

      setPending((previous) => ({ ...previous, [provider.id]: 'saving' }))
      setErrors((previous) => ({ ...previous, [provider.id]: undefined }))
      try {
        await saveProviders(
          providers.map((candidate) => (candidate.id === provider.id ? next : candidate))
        )
        const key = draft.key.trim()
        if (key.length > 0) {
          const api = window.kyclaw?.settings
          if (!api) throw new Error('密钥通道不可用（window.kyclaw 缺失），密钥没有保存')
          await api.setProviderKey(provider.id, key)
        }
        // 以落盘值重置草稿：key 清空（不回显），字段回到保存后的真相
        setDrafts((previous) => ({ ...previous, [provider.id]: draftOf(next) }))
        await refreshKeyStates()
        return true
      } catch (error) {
        setErrors((previous) => ({ ...previous, [provider.id]: messageOf(error) }))
        return false
      } finally {
        setPending((previous) => ({ ...previous, [provider.id]: undefined }))
      }
    },
    [drafts, providers, refreshKeyStates, saveProviders]
  )

  /** 测试连接：有未保存的改动就先存再测（测的就是"聊天接下来要走的那条路"） */
  const test = useCallback(
    async (provider: ProviderConfig): Promise<void> => {
      const draft = drafts[provider.id] ?? draftOf(provider)
      const dirty =
        draft.model.trim() !== provider.model ||
        (provider.type === 'openai-compatible' &&
          draft.baseUrl.trim() !== (provider.baseUrl ?? '')) ||
        draft.key.trim().length > 0

      setResults((previous) => ({ ...previous, [provider.id]: undefined }))
      setErrors((previous) => ({ ...previous, [provider.id]: undefined }))
      if (dirty && !(await save(provider))) return

      setPending((previous) => ({ ...previous, [provider.id]: 'testing' }))
      try {
        const api = window.kyclaw?.settings
        if (!api) throw new Error('设置通道不可用（window.kyclaw 缺失），没法测试连接')
        const result = await api.testProvider(provider.id)
        setResults((previous) => ({ ...previous, [provider.id]: result }))
        // round 22：连通了就把真实模型元数据抓回来（上下文长度/思考挡位；后台、静默）
        if (result.ok) void useSettingsStore.getState().probeModels(provider.id)
      } catch (error) {
        setErrors((previous) => ({ ...previous, [provider.id]: messageOf(error) }))
      } finally {
        setPending((previous) => ({ ...previous, [provider.id]: undefined }))
      }
    },
    [drafts, save]
  )

  const addPreset = useCallback(
    async (id: string): Promise<void> => {
      const preset = providerPreset(id)
      if (!preset || providers.some((provider) => provider.id === id)) return
      try {
        await saveProviders([...providers, providerFromPreset(preset, providers)])
        await refreshKeyStates()
      } catch (error) {
        setPageError(messageOf(error))
      }
    },
    [providers, refreshKeyStates, saveProviders]
  )

  const addCustom = useCallback(
    async (type: ProviderType): Promise<void> => {
      try {
        await saveProviders([...providers, newCustomProvider(providers, type)])
        await refreshKeyStates()
      } catch (error) {
        setPageError(messageOf(error))
      }
    },
    [providers, refreshKeyStates, saveProviders]
  )

  const setDefault = useCallback(
    async (id: string): Promise<void> => {
      try {
        await saveProviders(withDefaultProvider(providers, id))
      } catch (error) {
        setPageError(messageOf(error))
      }
    },
    [providers, saveProviders]
  )

  const remove = useCallback(
    async (id: string): Promise<void> => {
      try {
        await removeProvider(id)
        setDrafts((previous) => withoutKey(previous, id))
        setResults((previous) => withoutKey(previous, id))
        setErrors((previous) => withoutKey(previous, id))
        await refreshKeyStates()
      } catch (error) {
        setPageError(messageOf(error))
      }
    },
    [refreshKeyStates, removeProvider]
  )

  return (
    <div data-testid="model-settings" className="flex flex-col gap-4">
      {providers.length === 0 ? (
        <p data-testid="model-empty" className="text-b2 text-ink-secondary">
          还没有模型通道：从下面的预设里加一个，或选「自定义」。
        </p>
      ) : (
        providers.map((provider) => {
          const draft = drafts[provider.id] ?? draftOf(provider)
          const keyState = keyStates[provider.id]
          // 密钥状态未知时不报"缺 API 密钥"（读不到宁可不说；配置层面的缺项照报）
          const problems = providerConfigProblems(
            provider,
            keyState === undefined ? true : keyState.hasKey
          )
          const result = results[provider.id]
          const busy = pending[provider.id]

          return (
            <section
              key={provider.id}
              data-testid={`provider-${provider.id}`}
              className="flex flex-col gap-3 rounded-panel border border-hairline p-4"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-b1 font-medium text-ink">{providerLabel(provider)}</span>
                {provider.isDefault ? (
                  <span
                    data-testid={`provider-${provider.id}-default-badge`}
                    className="rounded-pill bg-selected px-2 py-0.5 text-c1 text-ink"
                  >
                    默认
                  </span>
                ) : null}
                <span
                  data-testid={`provider-${provider.id}-key-status`}
                  className="text-c1 text-ink-tertiary"
                >
                  {keyStatusText(keyState)}
                </span>
              </div>

              <label className="flex flex-col gap-1">
                <span className="text-b2 text-ink-secondary">模型</span>
                <Input
                  data-testid={`provider-${provider.id}-model`}
                  value={draft.model}
                  placeholder="模型名，如 deepseek-flash"
                  onChange={(event) => patchDraft(provider, { model: event.target.value })}
                />
              </label>

              {provider.type === 'openai-compatible' ? (
                <label className="flex flex-col gap-1">
                  <span className="text-b2 text-ink-secondary">Base URL</span>
                  <Input
                    data-testid={`provider-${provider.id}-base-url`}
                    value={draft.baseUrl}
                    placeholder="https://…/v1"
                    onChange={(event) => patchDraft(provider, { baseUrl: event.target.value })}
                  />
                </label>
              ) : null}

              <label className="flex flex-col gap-1">
                <span className="text-b2 text-ink-secondary">API Key</span>
                <Input
                  type="password"
                  autoComplete="off"
                  data-testid={`provider-${provider.id}-key`}
                  value={draft.key}
                  placeholder={keyState?.hasKey ? '已保存；要换就填新的' : '粘贴 API Key'}
                  onChange={(event) => patchDraft(provider, { key: event.target.value })}
                />
              </label>

              {keyState?.needsReentry ? (
                <p
                  data-testid={`provider-${provider.id}-reentry`}
                  className="text-c1 text-ink-secondary"
                >
                  已存的密钥在这台机器上读不到，请重新录入。
                </p>
              ) : null}

              {problems.length > 0 ? (
                <p data-testid={`provider-${provider.id}-problems`} className="text-c1 text-danger">
                  {problems.join('；')}
                </p>
              ) : null}

              <div className="flex flex-wrap items-center gap-3">
                <Button
                  size="sm"
                  data-testid={`provider-${provider.id}-save`}
                  loading={busy === 'saving'}
                  onClick={() => void save(provider)}
                >
                  保存
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid={`provider-${provider.id}-test`}
                  loading={busy === 'testing'}
                  onClick={() => void test(provider)}
                >
                  测试连接
                </Button>
                {provider.isDefault ? null : (
                  <Button
                    size="sm"
                    variant="ghost"
                    data-testid={`provider-${provider.id}-set-default`}
                    onClick={() => void setDefault(provider.id)}
                  >
                    设为默认
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid={`provider-${provider.id}-remove`}
                  onClick={() => void remove(provider.id)}
                >
                  删除
                </Button>
              </div>

              {result ? (
                <p
                  data-testid={`provider-${provider.id}-test-result`}
                  className="text-c1 text-ink-secondary"
                >
                  {result.ok
                    ? `连接正常，延迟 ${result.latencyMs} ms`
                    : `连接失败：${result.message}`}
                </p>
              ) : null}

              {errors[provider.id] ? (
                <p data-testid={`provider-${provider.id}-error`} className="text-c1 text-danger">
                  {errors[provider.id]}
                </p>
              ) : null}
            </section>
          )
        })
      )}

      <div className="flex flex-col gap-2">
        <span className="text-b2 text-ink-secondary">添加通道</span>
        <div data-testid="provider-presets" className="flex flex-wrap gap-3">
          {PROVIDER_PRESETS.map((preset) => {
            const added = providers.some((provider) => provider.id === preset.id)
            return (
              <Chip
                key={preset.id}
                data-testid={`add-preset-${preset.id}`}
                disabled={added}
                onClick={() => void addPreset(preset.id)}
              >
                {added ? `${preset.label}（已添加）` : preset.label}
              </Chip>
            )
          })}
          <Chip
            data-testid="add-custom-openai-compatible"
            onClick={() => void addCustom('openai-compatible')}
          >
            自定义（OpenAI 兼容）
          </Chip>
          <Chip data-testid="add-custom-anthropic" onClick={() => void addCustom('anthropic')}>
            自定义（Anthropic）
          </Chip>
        </div>
      </div>

      {pageError ? (
        <p data-testid="model-page-error" className="text-c1 text-danger">
          {pageError}
        </p>
      ) : null}
    </div>
  )
}
