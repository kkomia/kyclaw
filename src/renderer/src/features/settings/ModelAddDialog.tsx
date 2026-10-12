import { ChevronDown } from 'lucide-react'
import { unwrapIpcError } from '@renderer/lib/ipc-error'
import { useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Dialog } from '@renderer/components/ui/dialog'
import { Input } from '@renderer/components/ui/input'
import { Menu, type MenuEntry } from '@renderer/components/ui/menu'
import { useSettingsStore } from '@renderer/lib/settings-store'
import {
  newCustomProvider,
  providerFromPreset,
  providerPreset,
  PROVIDER_PRESETS,
  type ProviderConfig,
  type ProviderType
} from '@shared/providers'

/**
 * 「新增模型」弹窗（round 48 用户口径：**先出弹窗，再选渠道**）。
 *
 * 渠道不再铺在设置页上（之前那排 chips 把页面撑得很长）：卡右上角一个「新增」开这张框，
 * 渠道收进下拉 —— 内置渠道（已添加的置灰）+ 两条「自定义」。
 * 选中后只问三件事：模型（预设带默认名）、Base URL（openai 兼容型要填）、API Key（可以留空，
 * 之后在展开行里补）；提交即落盘，填了 key 就连带写进安全存储并补一发能力探测
 * （与展开行里"保存完 key 补发"同一口径，见 ModelSettings.save）。
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
  const [model, setModel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState<string | undefined>(undefined)

  // 开窗的那一帧把上一次的内容清干净（关窗期间清也一样，看不见）
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setChannel(null)
      setSetup(null)
      setModel('')
      setBaseUrl('')
      setKey('')
      setBusy(false)
      setFormError(undefined)
    }
  }

  const selectChannel = (next: ChannelKey): void => {
    const chosen = setupFor(next, providers)
    setChannel(next)
    setSetup(chosen)
    setModel(chosen.provider.model)
    setBaseUrl(chosen.provider.baseUrl ?? '')
    setKey('')
    setFormError(undefined)
  }

  /** 渠道下拉的条目：同一条内置渠道只能加一次（已添加的置灰，与旧 chips 的语义一致） */
  const channelItems: MenuEntry[] = [
    ...PROVIDER_PRESETS.map((preset) => ({
      id: `preset:${preset.id}`,
      label: preset.label,
      disabled: providers.some((provider) => provider.id === preset.id),
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

  const submit = async (): Promise<void> => {
    if (!setup) return
    const trimmedModel = model.trim()
    const trimmedBaseUrl = baseUrl.trim()
    const missing: string[] = []
    if (trimmedModel.length === 0) missing.push('缺模型名')
    if (setup.needsBaseUrl && trimmedBaseUrl.length === 0) missing.push('缺 Base URL')
    if (missing.length > 0) {
      setFormError(`配置不完整：${missing.join('；')}`)
      return
    }

    const provider: ProviderConfig = {
      ...setup.provider,
      model: trimmedModel,
      baseUrl: setup.needsBaseUrl ? trimmedBaseUrl : undefined
    }

    setBusy(true)
    setFormError(undefined)
    try {
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

        {setup === null ? null : (
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
                  onChange={(event) => setBaseUrl(event.target.value)}
                />
              </label>
            ) : null}

            <label className="flex flex-col gap-1">
              <span className="text-b2 text-ink-secondary">API Key</span>
              <Input
                type="password"
                autoComplete="off"
                data-testid="model-add-key"
                value={key}
                placeholder="可以留空，之后在列表里补"
                onChange={(event) => setKey(event.target.value)}
              />
            </label>
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
