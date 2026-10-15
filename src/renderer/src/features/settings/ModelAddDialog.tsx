import { ChevronDown } from 'lucide-react'
import { unwrapIpcError } from '@renderer/lib/ipc-error'
import { useEffect, useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Dialog } from '@renderer/components/ui/dialog'
import { Input } from '@renderer/components/ui/input'
import { Menu, type MenuEntry } from '@renderer/components/ui/menu'
import { useSettingsStore } from '@renderer/lib/settings-store'
import type { ProviderModelOption } from '@shared/ipc'
import { formatTokens } from '@shared/models'
import {
  newCustomProvider,
  providerFromPreset,
  providerLabel,
  providerPreset,
  providerWithBaseUrl,
  PROVIDER_PRESETS,
  withRegisteredModel,
  type ProviderConfig,
  type ProviderType
} from '@shared/providers'

/**
 * 「新增模型」弹窗（round 48 用户口径：**先出弹窗，再选渠道**）。
 *
 * 渠道不再铺在设置页上（之前那排 chips 把页面撑得很长）：卡右上角一个「新增」开这张框，
 * 渠道收进下拉 —— 内置渠道 + 两条「自定义」。
 *
 * 两种落法（用户反馈 001：**同一条端点可以有多个模型**）：
 *   - **新通道**：这条 baseUrl / 这个内置渠道还没有配过 —— 问三件事：模型（预设带默认名）、
 *     Base URL（openai 兼容型要填）、可选渠道名 + API Key（可以留空，之后在展开行里补）。
 *     这一档还有**「发现模型」**（用户反馈 007）：点一下就用**刚填的**地址与密钥列一次
 *     端点上的模型（`settings:discover-provider-models`，**只读、不落盘**）。显式按钮而不是
 *     "每次键入就发请求"；密钥只在这一次调用里过桥（用完即弃，不进日志、不落盘）；
 *     **密钥允许留空**——本机服务（LM Studio / llama.cpp / ollama）不要密钥，要不要认证由
 *     服务说了算：回 401/403 就把"这个端点需要 API Key"带回来，界面不替它一刀切；
 *     "读不到（给原因）"与"端点没给清单（手填）"分开说。手填永远有效。
 *   - **给端点加模型**：baseUrl 已经是某条 provider（内置渠道已添加、或自定义里填了同一个地址）
 *     —— **不新建 provider、不再要 key**，只在它的 `models` 清单里加一个并选中它。
 *     这一档用该 provider 的密钥读一次 `GET /models`（`settings:list-provider-models`，
 *     同样只读不落盘）；读不到就静默（一行提示 + 手填），"端点没有 /models" 不是错误。
 *
 * 失败一律**留在弹窗里**（人话：缺什么说什么 / 主进程剥壳后的原因），不关窗、不清空已填内容。
 * 表单**不随开合卸载**（关窗那一下还要跑退场动效）；重开时按 `open` 的上升沿清成空白表单
 * —— 用 render 期间的条件 setState（与 chat/parts/TraceFold 的 everOpened 同一手法）。
 */
type ChannelKey = ProviderType | `preset:${string}`

const CUSTOM_CHANNELS: ReadonlyArray<{ key: ProviderType; label: string }> = [
  { key: 'openai-compatible', label: '自定义（OpenAI 兼容）' },
  { key: 'anthropic', label: '自定义（Anthropic）' }
]

/** 渠道选择的结果：落盘要的那条配置 + 这一档要不要 Base URL */
interface ChannelSetup {
  provider: ProviderConfig
  /** anthropic 走官方端点，不问 Base URL */
  needsBaseUrl: boolean
}

/**
 * 「发现模型」的结果。三态是刻意的：`failed` 是"读不到（有原因）"，`ok` + 空清单是
 * "读到了、端点就是没给模型"——两者在界面上要说不同的话（007）。
 */
type DiscoverState =
  | { kind: 'loading' }
  | { kind: 'ok'; models: ProviderModelOption[] }
  | { kind: 'failed'; message: string }

function setupFor(channel: ChannelKey, existing: readonly ProviderConfig[]): ChannelSetup {
  if (channel === 'openai-compatible' || channel === 'anthropic') {
    const provider = newCustomProvider(existing, channel)
    return { provider, needsBaseUrl: channel === 'openai-compatible' }
  }
  const preset = providerPreset(channel.slice('preset:'.length))
  if (!preset) throw new Error(`没有这个渠道：${channel}`)
  return {
    provider: providerFromPreset(preset, existing),
    needsBaseUrl: preset.type !== 'anthropic'
  }
}

function channelLabel(channel: ChannelKey): string {
  if (channel === 'openai-compatible') return '自定义（OpenAI 兼容）'
  if (channel === 'anthropic') return '自定义（Anthropic）'
  return providerPreset(channel.slice('preset:'.length))?.label ?? channel
}

function messageOf(error: unknown): string {
  // round 25：展示前统一剥 IPC 包装（`Error invoking remote method …` 不再露给用户）
  return unwrapIpcError(error)
}

/**
 * 端点上的可选模型：一个下拉，选中即填进「模型」那一栏（手填永远还有效）。
 * 两种来源共用它 —— 已保存的端点（`listProviderModels`，按 provider id）与
 * 还没保存的新端点（`discoverProviderModels`，地址与密钥现给）。
 */
function ModelOptionsMenu({
  testId,
  options,
  onPick
}: {
  testId: string
  options: ProviderModelOption[]
  onPick: (id: string) => void
}): React.JSX.Element {
  const items: MenuEntry[] = options.map((option) => ({
    id: option.id,
    label: option.id,
    trailing: option.contextWindow === undefined ? undefined : formatTokens(option.contextWindow),
    testId: `${testId}-${option.id}`,
    onSelect: () => onPick(option.id)
  }))
  return (
    <Menu
      align="start"
      items={items}
      trigger={
        <button
          type="button"
          data-testid={testId}
          aria-label="端点上的模型"
          className="flex h-(--field-height) w-full items-center justify-between rounded-field border-(length:--hairline-width) border-(--border-field) bg-(--field-bg) px-3 text-left text-b2 text-ink transition-colors duration-(--motion-fast) ease-main hover:bg-hover"
        >
          <span>{`选一个（${options.length} 个可选）`}</span>
          <ChevronDown
            aria-hidden="true"
            className="size-(--icon-size-sm) shrink-0 text-ink-tertiary"
          />
        </button>
      }
    />
  )
}

export interface ModelAddDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 新建成功：调用方刷新密钥状态并把这一行展开 */
  onAdded: (id: string) => Promise<void> | void
}

export function ModelAddDialog({
  open,
  onOpenChange,
  onAdded
}: ModelAddDialogProps): React.JSX.Element {
  const providers = useSettingsStore((state) => state.settings.providers)

  const [channel, setChannel] = useState<ChannelKey | null>(null)
  const [setup, setSetup] = useState<ChannelSetup | null>(null)
  const [name, setName] = useState('')
  const [model, setModel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState<string | undefined>(undefined)
  /** 端点上读到的可选模型（null = 还没读到 / 这一档不需要；空数组 = 读不到，手填） */
  const [options, setOptions] = useState<ProviderModelOption[] | null>(null)
  /** 新渠道那一档"发现模型"的结果：失败与"清单是空的"要分开说（007 的要求） */
  const [discover, setDiscover] = useState<DiscoverState | null>(null)

  // 开窗的那一帧把上一次的内容清干净（关窗期间清也一样，看不见）
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setChannel(null)
      setSetup(null)
      setName('')
      setModel('')
      setBaseUrl('')
      setKey('')
      setBusy(false)
      setFormError(undefined)
      setOptions(null)
      setDiscover(null)
    }
  }

  /**
   * 这条渠道现在落在哪一条**已存在的 provider** 上（001：往它加模型，不新建、不再要 key）。
   * 顺序：先按 baseUrl 认（自定义填了同一个地址 = 同一条端点），再看这个渠道 id 是否已经配过
   * （内置渠道已添加 —— 兜底：即便用户把 Base URL 改成别的，也不会凭同一个 id 造出第二条 provider）。
   */
  const appendTarget =
    setup === null
      ? undefined
      : (providerWithBaseUrl(providers, baseUrl) ??
        providers.find((provider) => provider.id === setup.provider.id))
  const appending = appendTarget !== undefined

  /**
   * 进/出"给端点加模型"这一档时的复位：模型那一栏从空开始（要加的是**新**的一个）、
   * 上一次读到的清单作废。用 render 期间的条件 setState（与上面的开窗复位、TraceFold 同一手法），
   * 不在 effect 里同步 setState。
   */
  const targetId = appendTarget?.id
  const [lastTargetId, setLastTargetId] = useState<string | undefined>(undefined)
  if (targetId !== lastTargetId) {
    setLastTargetId(targetId)
    setOptions(null)
    if (targetId !== undefined) setModel('')
  }

  // 读一次端点清单（只读发现；读不到 = 空表，手填兜底）。setState 只在异步回调里，
  // 不在 effect 体里同步改状态。
  useEffect(() => {
    if (targetId === undefined) return
    let cancelled = false
    void (async () => {
      try {
        const list = await window.kyclaw?.settings?.listProviderModels?.(targetId)
        if (!cancelled) setOptions(list ?? [])
      } catch {
        // 读不到清单不是错误（端点没有 /models、认证失败、超时…）：手填就行
        if (!cancelled) setOptions([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [targetId])

  const selectChannel = (next: ChannelKey): void => {
    const chosen = setupFor(next, providers)
    setChannel(next)
    setSetup(chosen)
    setName('')
    setModel(chosen.provider.model)
    setBaseUrl(chosen.provider.baseUrl ?? '')
    setKey('')
    setFormError(undefined)
    setOptions(null)
    setDiscover(null)
  }

  /**
   * 「发现模型」（007 补齐）：拿**这一档刚填的**地址与密钥问一次端点上有哪些模型 ——
   * 于是新注册这条路不必"先手填一个模型名、存下去"才能看到清单。
   *
   * 三条纪律：
   *   - **显式按钮**，不是"每次键入就发请求"（用户敲 URL 的每个字符都不该打端点）；
   *   - 密钥**只在这条调用里过桥**：主进程用完即弃，不落盘、不进日志、不回包
   *     （保存仍然走 setProviderKey 那条路；这里不写任何密钥存储）；
   *   - 失败与空清单分开报：`failed` 说原因，空清单说"端点没给清单，手填就行"。
   */
  const runDiscover = async (): Promise<void> => {
    if (setup === null) return
    setDiscover({ kind: 'loading' })
    try {
      const api = window.kyclaw?.settings
      if (!api?.discoverProviderModels) {
        setDiscover({ kind: 'failed', message: '设置通道不可用（window.kyclaw 缺失）' })
        return
      }
      const trimmedBaseUrl = baseUrl.trim()
      const result = await api.discoverProviderModels({
        type: setup.provider.type,
        ...(trimmedBaseUrl === '' ? {} : { baseUrl: trimmedBaseUrl }),
        // 密钥可以留空：本机服务（LM Studio 等）不要密钥，空串交给服务自己判
        apiKey: key.trim()
      })
      setDiscover(
        result.ok
          ? { kind: 'ok', models: result.models }
          : { kind: 'failed', message: result.message }
      )
    } catch (error) {
      setDiscover({ kind: 'failed', message: messageOf(error) })
    }
  }

  /** 渠道下拉的条目（001：已添加的内置渠道照样可选 —— 选中 = 往那条端点加一个模型） */
  const channelItems: MenuEntry[] = [
    ...PROVIDER_PRESETS.map((preset) => ({
      id: `preset:${preset.id}`,
      label: providers.some((provider) => provider.id === preset.id)
        ? `${preset.label}（加模型）`
        : preset.label,
      testId: `model-add-channel-preset-${preset.id}`,
      onSelect: () => selectChannel(`preset:${preset.id}`)
    })),
    ...CUSTOM_CHANNELS.map((custom) => ({
      id: custom.key,
      label: custom.label,
      testId: `model-add-channel-custom-${custom.key}`,
      onSelect: () => selectChannel(custom.key)
    }))
  ]

  /**
   * 这一档现在能不能去发现模型：**只要有地址**就能试（用户反馈 007 的补充说明）。
   * 本机服务（LM Studio / llama.cpp / ollama 那类）压根不要 API Key —— 前端拿"必须填密钥"
   * 一刀切，正好把"离线也能用"的那条路挡死。要不要密钥由**服务自己**说了算：
   * 端点回 401/403 就带一句"这个端点需要 API Key"回来，不该由界面替它判。
   */
  const canDiscover = setup !== null && !appending && setup.needsBaseUrl && baseUrl.trim() !== ''

  const submit = async (): Promise<void> => {
    if (!setup) return
    const trimmedModel = model.trim()
    const trimmedBaseUrl = baseUrl.trim()
    const missing: string[] = []
    if (trimmedModel.length === 0) missing.push('缺模型名')
    if (!appending && setup.needsBaseUrl && trimmedBaseUrl.length === 0) missing.push('缺 Base URL')
    if (missing.length > 0) {
      setFormError(`配置不完整：${missing.join('；')}`)
      return
    }

    setBusy(true)
    setFormError(undefined)
    try {
      if (appendTarget !== undefined) {
        // 给这条端点加模型（001）：清单去重追加、`model` 选中新模型；**不动密钥、不新建 provider**
        const next = withRegisteredModel(appendTarget, trimmedModel)
        await useSettingsStore
          .getState()
          .saveProviders(
            providers.map((candidate) => (candidate.id === next.id ? next : candidate))
          )
        onOpenChange(false)
        await onAdded(next.id)
        return
      }

      const provider: ProviderConfig = {
        ...setup.provider,
        name: name.trim() === '' ? undefined : name.trim(),
        model: trimmedModel,
        baseUrl: setup.needsBaseUrl ? trimmedBaseUrl : undefined
      }
      await useSettingsStore.getState().saveProviders([...providers, provider])
      const trimmedKey = key.trim()
      if (trimmedKey.length > 0) {
        const api = window.kyclaw?.settings
        if (!api) throw new Error('密钥通道不可用（window.kyclaw 缺失），密钥没有保存')
        await api.setProviderKey(provider.id, trimmedKey)
        // 新密钥刚落地：配置那一趟探测（settings:update）当时还没有 key，这里补一发（同展开行的口径）
        void useSettingsStore.getState().probeModels(provider.id)
      }
      onOpenChange(false)
      await onAdded(provider.id)
    } catch (error) {
      setFormError(messageOf(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="新增模型"
      size="md"
      footer={
        <>
          <Button
            variant="ghost"
            data-testid="model-add-cancel"
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button
            data-testid="model-add-submit"
            loading={busy}
            disabled={setup === null}
            onClick={() => void submit()}
          >
            添加
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <span className="text-b2 text-ink-secondary">渠道</span>
          <Menu
            align="start"
            items={channelItems}
            trigger={
              <button
                type="button"
                data-testid="model-add-channel"
                aria-label="渠道"
                className="flex h-(--field-height) w-full items-center justify-between rounded-field border-(length:--hairline-width) border-(--border-field) bg-(--field-bg) px-3 text-left text-b2 text-ink transition-colors duration-(--motion-fast) ease-main hover:bg-hover"
              >
                <span className={channel === null ? 'text-(--text-quaternary)' : undefined}>
                  {channel === null ? '选一个渠道' : channelLabel(channel)}
                </span>
                <ChevronDown
                  aria-hidden="true"
                  className="size-(--icon-size-sm) shrink-0 text-ink-tertiary"
                />
              </button>
            }
          />
        </div>

        {setup === null ? null : appending && appendTarget !== undefined ? (
          <>
            <p data-testid="model-add-append-hint" className="text-c1 text-ink-secondary">
              往「{providerLabel(appendTarget)}」这条端点加一个模型：不用再填密钥。
            </p>

            <label className="flex flex-col gap-1">
              <span className="text-b2 text-ink-secondary">模型</span>
              <Input
                data-testid="model-add-model"
                value={model}
                placeholder="模型名，如 deepseek-v4-pro"
                onChange={(event) => setModel(event.target.value)}
              />
            </label>

            <div className="flex flex-col gap-1">
              <span className="text-b2 text-ink-secondary">端点上的模型</span>
              {options === null ? (
                <span
                  data-testid="model-add-available-loading"
                  className="text-c1 text-ink-tertiary"
                >
                  正在读这条端点的模型清单…
                </span>
              ) : options.length === 0 ? (
                <span data-testid="model-add-available-empty" className="text-c1 text-ink-tertiary">
                  没读到这条端点的模型清单——直接在上面手填模型名也可以。
                </span>
              ) : (
                <ModelOptionsMenu
                  testId="model-add-available"
                  options={options}
                  onPick={setModel}
                />
              )}
            </div>
          </>
        ) : (
          <>
            <label className="flex flex-col gap-1">
              <span className="text-b2 text-ink-secondary">模型</span>
              <Input
                data-testid="model-add-model"
                value={model}
                placeholder="模型名，如 deepseek-flash"
                onChange={(event) => setModel(event.target.value)}
              />
            </label>

            {setup.needsBaseUrl ? (
              <label className="flex flex-col gap-1">
                <span className="text-b2 text-ink-secondary">Base URL</span>
                <Input
                  data-testid="model-add-base-url"
                  value={baseUrl}
                  placeholder="https://…/v1"
                  onChange={(event) => {
                    setBaseUrl(event.target.value)
                    // 地址变了，上一次的清单就是别的端点的：作废（免得挑到那条端点上的模型名）
                    setDiscover(null)
                  }}
                />
              </label>
            ) : null}

            <label className="flex flex-col gap-1">
              <span className="text-b2 text-ink-secondary">名称</span>
              <Input
                data-testid="model-add-name"
                value={name}
                placeholder="渠道显示名（可留空）"
                onChange={(event) => setName(event.target.value)}
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-b2 text-ink-secondary">API Key</span>
              <Input
                type="password"
                autoComplete="off"
                data-testid="model-add-key"
                value={key}
                placeholder="可以留空，之后在列表里补"
                onChange={(event) => {
                  setKey(event.target.value)
                  setDiscover(null)
                }}
              />
            </label>

            {setup.needsBaseUrl ? (
              <div className="flex flex-col gap-1">
                <span className="flex items-center gap-2 text-b2 text-ink-secondary">
                  端点上的模型
                  <Button
                    size="sm"
                    variant="ghost"
                    data-testid="model-add-discover"
                    disabled={!canDiscover || discover?.kind === 'loading'}
                    onClick={() => void runDiscover()}
                  >
                    发现模型
                  </Button>
                </span>

                {discover === null ? (
                  <span data-testid="model-add-discover-hint" className="text-c1 text-ink-tertiary">
                    {canDiscover
                      ? '点「发现模型」把这条端点上的模型列出来挑；也可以直接手填模型名。本机服务不用密钥也能试。'
                      : '填好 Base URL 就能发现端点上的模型；不发现也可以直接手填模型名。'}
                  </span>
                ) : discover.kind === 'loading' ? (
                  <span
                    data-testid="model-add-discover-loading"
                    className="text-c1 text-ink-tertiary"
                  >
                    正在读这条端点的模型清单…
                  </span>
                ) : discover.kind === 'failed' ? (
                  <span data-testid="model-add-discover-error" className="text-c1 text-danger">
                    {`读不到这条端点的模型清单：${discover.message}`}
                  </span>
                ) : discover.models.length === 0 ? (
                  <span
                    data-testid="model-add-discover-empty"
                    className="text-c1 text-ink-tertiary"
                  >
                    这条端点没有给出模型清单——直接在上面手填模型名也可以。
                  </span>
                ) : (
                  <ModelOptionsMenu
                    testId="model-add-discovered"
                    options={discover.models}
                    onPick={setModel}
                  />
                )}
              </div>
            ) : null}
          </>
        )}

        {formError === undefined ? null : (
          <p data-testid="model-add-error" className="text-c1 text-danger">
            {formError}
          </p>
        )}
      </div>
    </Dialog>
  )
}
