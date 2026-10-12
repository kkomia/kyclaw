import { ChevronRight, Eye } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { cn } from '@renderer/components/ui/cn'
import { Input } from '@renderer/components/ui/input'
import { TraceFold } from '@renderer/features/chat/parts/TraceFold'
import type { ConnectionTestResult } from '@shared/ipc'
import { contextWindowOf, formatTokens, visionOf, type ProbedModelSpec } from '@shared/models'
import {
  providerConfigProblems,
  providerLabel,
  type ProviderConfig,
  type ProviderKeyState
} from '@shared/providers'

/** 视觉能力的标记文案（与 composer 模型菜单的 VISION_MARK 同口径，见 ComposerControls） */
const VISION_MARK = '看图'

export interface ProviderDraft {
  model: string
  baseUrl: string
  /** 待写入的新密钥；保存成功后立刻清空（已存的密钥不回显） */
  key: string
}

/** 密钥状态还没读到时的显示：不猜"未配置"（免得一闪而过的误报） */
function keyStatusText(state: ProviderKeyState | undefined): string {
  if (!state) return '读取中…'
  if (state.needsReentry) return '需要重新录入'
  return state.hasKey ? '已配置' : '未配置'
}

export interface ProviderRowProps {
  provider: ProviderConfig
  open: boolean
  onToggle: () => void
  draft: ProviderDraft
  onDraftChange: (patch: Partial<ProviderDraft>) => void
  keyState: ProviderKeyState | undefined
  probed: ProbedModelSpec | undefined
  pending: 'saving' | 'testing' | undefined
  result: ConnectionTestResult | undefined
  error: string | undefined
  onSave: () => void
  onTest: () => void
  onSetDefault: () => void
  onRemove: () => void
}

/**
 * 已配置模型的一行（round 48 用户口径）：**默认折叠**，只留最基本信息——
 * 名字（provider 标签 + 模型名）、上下文、能力图标、是不是默认；点整行才展开编辑。
 *
 * 折叠行**不描边**（上一版每行一张卡都有框线，近距堆好几层；这里只用 hover 填充），
 * 展开区沿用全局折叠配方 `.trace-fold`（grid-template-rows 双向过渡，不硬切）。
 * 编辑能力与上一版**逐项照旧**：模型 / Base URL / API Key / 保存 / 测试连接 / 设为默认 / 删除，
 * 密钥状态 + 重录引导 + 半截配置提示一起收进展开区（折叠行上不再用文字解释）。
 */
export function ProviderRow({
  provider,
  open,
  onToggle,
  draft,
  onDraftChange,
  keyState,
  probed,
  pending,
  result,
  error,
  onSave,
  onTest,
  onSetDefault,
  onRemove
}: ProviderRowProps): React.JSX.Element {
  // 密钥状态未知时不报"缺 API 密钥"（读不到宁可不说；配置层面的缺项照报）
  const problems = providerConfigProblems(provider, keyState === undefined ? true : keyState.hasKey)
  const vision = visionOf(provider.model, probed)

  return (
    <div data-testid={`provider-${provider.id}`} className="flex flex-col rounded-panel">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full items-center gap-2 rounded-panel px-3 py-2 text-left transition-colors duration-(--motion-fast) ease-main hover:bg-hover"
      >
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="shrink-0 text-b1 font-medium text-ink">{providerLabel(provider)}</span>
          {provider.model.trim().length === 0 ? null : (
            <span className="min-w-0 truncate text-b2 text-ink-secondary">{provider.model}</span>
          )}
        </span>

        <span className="shrink-0 text-c1 text-ink-secondary">
          {formatTokens(contextWindowOf(provider.model, probed))}
        </span>

        {vision ? (
          <Eye
            data-testid={`provider-${provider.id}-vision`}
            role="img"
            aria-label={VISION_MARK}
            className="size-(--icon-size-sm) shrink-0 text-ink-secondary"
          />
        ) : null}

        {provider.isDefault ? (
          <span
            data-testid={`provider-${provider.id}-default-badge`}
            className="shrink-0 rounded-pill bg-selected px-2 py-0.5 text-c1 text-ink"
          >
            默认
          </span>
        ) : null}

        <ChevronRight
          aria-hidden="true"
          className={cn(
            'size-4 shrink-0 text-ink-tertiary transition-transform duration-(--motion-fast) ease-main motion-reduce:transition-none',
            open && 'rotate-90'
          )}
        />
      </button>

      <TraceFold open={open}>
        <div className="flex flex-col gap-3 px-3 pt-2 pb-3">
          <div className="flex flex-wrap items-center gap-2">
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
              onChange={(event) => onDraftChange({ model: event.target.value })}
            />
          </label>

          {provider.type === 'openai-compatible' ? (
            <label className="flex flex-col gap-1">
              <span className="text-b2 text-ink-secondary">Base URL</span>
              <Input
                data-testid={`provider-${provider.id}-base-url`}
                value={draft.baseUrl}
                placeholder="https://…/v1"
                onChange={(event) => onDraftChange({ baseUrl: event.target.value })}
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
              onChange={(event) => onDraftChange({ key: event.target.value })}
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
              loading={pending === 'saving'}
              onClick={onSave}
            >
              保存
            </Button>
            <Button
              size="sm"
              variant="ghost"
              data-testid={`provider-${provider.id}-test`}
              loading={pending === 'testing'}
              onClick={onTest}
            >
              测试连接
            </Button>
            {provider.isDefault ? null : (
              <Button
                size="sm"
                variant="ghost"
                data-testid={`provider-${provider.id}-set-default`}
                onClick={onSetDefault}
              >
                设为默认
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              data-testid={`provider-${provider.id}-remove`}
              onClick={onRemove}
            >
              删除
            </Button>
          </div>

          {result ? (
            <p
              data-testid={`provider-${provider.id}-test-result`}
              className="text-c1 text-ink-secondary"
            >
              {result.ok ? `连接正常，延迟 ${result.latencyMs} ms` : `连接失败：${result.message}`}
            </p>
          ) : null}

          {error === undefined ? null : (
            <p data-testid={`provider-${provider.id}-error`} className="text-c1 text-danger">
              {error}
            </p>
          )}
        </div>
      </TraceFold>
    </div>
  )
}
