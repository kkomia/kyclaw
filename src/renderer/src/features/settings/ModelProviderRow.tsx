import { ChevronRight, Eye } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { cn } from '@renderer/components/ui/cn'
import { Input } from '@renderer/components/ui/input'
import { Menu, type MenuEntry } from '@renderer/components/ui/menu'
import { TraceFold } from '@renderer/features/chat/parts/TraceFold'
import type { ConnectionTestResult } from '@shared/ipc'
import {
  CONTEXT_WINDOW_SOURCE_LABELS,
  contextWindowOf,
  contextWindowSourceOf,
  displayNameOf,
  formatTokens,
  visionOf,
  type ModelOverride,
  type ProbedModelSpec
} from '@shared/models'
import {
  providerConfigProblems,
  providerLabel,
  registeredModelsOf,
  type ProviderConfig,
  type ProviderKeyState
} from '@shared/providers'
import {
  CONNECTION_TEST_STATUS_LABELS,
  CONNECTION_TEST_STEP_LABELS,
  connectionTestHeadline
} from './status-text'
import { SecretField } from './SecretField'

/** 视觉能力的标记文案（与 composer 模型菜单的 VISION_MARK 同口径，见 ComposerControls） */
const VISION_MARK = '看图'

export interface ProviderDraft {
  /** 002：渠道名称（空 = 按 id 猜，见 providerLabel） */
  name: string
  model: string
  /** 001：这条端点已注册的模型清单（草稿；保存时落盘。空/只有当前这个 = 不写 models 字段） */
  models: string[]
  /** 004：模型名称（只影响展示；空 = 用模型 ID 原文） */
  displayName: string
  /** 003：手动上下文长度（tokens，文本形态；空/非法 = 不动手动值） */
  contextWindow: string
  baseUrl: string
  /** 待写入的新密钥；保存成功后立刻清空（已存密钥只在用户点眼睛时临时回显） */
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
  /** 003/004 的手动覆盖（`<providerId>:<model>` 那一条；没有 = 全走实测/回退） */
  override: ModelOverride | undefined
  pending: 'saving' | 'testing' | undefined
  result: ConnectionTestResult | undefined
  error: string | undefined
  /** 上一次保存的结果（012：保存按钮点完要有反馈） */
  notice: string | undefined
  onSave: () => void
  onTest: () => void
  onSetDefault: () => void
  onRemove: () => void
  /** 003：「恢复探测值」——把上下文长度那一栏退回实测/回退值（保存时清掉手动值） */
  onResetContext: () => void
  /** 001：在这条端点**已注册的模型**之间切换（填进「模型」那一栏，保存即生效） */
  onUseRegisteredModel: (model: string) => void
  /** 001：把一个模型从这条端点的注册清单里摘掉（当前选中的那个不给摘，见下） */
  onDropRegisteredModel: (model: string) => void
  /**
   * 密钥显隐的复位序号：父级在展开/收起任一行、任一行开始保存 / 保存成功时 +1。
   * 行内只把明文展示（本次输入或显式回显的已存 key）保留到"这一次展开 / 这一次保存"为止
   * （只复位显示态，不动草稿）。
   */
  revealEpoch: number
}

/**
 * 已配置模型的一行（round 48 用户口径）：**默认折叠**，只留最基本信息——
 * 渠道名 + 模型名称、上下文（连带**来源**标注：实测 / 回退 / 手动）、能力图标、是不是默认；
 * 点整行才展开编辑。
 *
 * 折叠行**不描边**（上一版每行一张卡都有框线，近距堆好几层；这里只用 hover 填充），
 * 展开区沿用全局折叠配方 `.trace-fold`（grid-template-rows 双向过渡，不硬切）。
 * 编辑能力与上一版**逐项照旧**（模型 ID / Base URL / API Key / 保存 / 测试连接 / 设为默认 / 删除），
 * 另加用户反馈的几项：渠道名称（002）、模型名称（004）、手动上下文长度 + 来源 + 恢复探测值（003）；
 * 密钥状态 + 重录引导 + 半截配置提示一起收进展开区（折叠行上不再用文字解释）。
 *
 * 009 返工（用户验收口径）：
 *   - 输入框的说明/示例 placeholder 全删（与注册弹窗同一口径）；输入说明小字也删
 *     （模型名称下面那句"只影响显示…"不再占位；已存 API Key 的圆点占位是状态提示，不在删除之列）；
 *   - 身份字段收成一组：**渠道名称**独占一行，**模型名称与模型 ID 同一行**；
 *   - 注册与编辑用同一套字段名；落盘字段仍是 provider.name / provider.model /
 *     settings.modelOverrides，语义不动；
 *   - 动态面照留：密钥状态、上下文来源与实测/回退值、缺项/重录/保存反馈/测试连接结果。
 *
 * API Key 显隐（用户复验 2026-10-17）：输入框默认 `password`；本次有新输入时眼睛只切换
 * 掩码/明文；本次没有输入但已有可用密钥时，**点眼睛才**经 `settings:reveal-provider-key`
 * 回显真实 key（掩码态的固定圆点串只是占位视觉）。收起折叠、切到别的 provider、开始保存 /
 * 保存成功都立即复位并清掉本地明文（父级 `revealEpoch` + SecretField 内的展示态复位）；
 * 未配置 / needsReentry 不调用回显通道。眼睛按钮不在 label 内，且点击时把焦点送回输入框
 * ——否则"点眼睛再直接键入"会落在按钮上，输入框一直空白（见 SecretField）。
 */
export function ProviderRow({
  provider,
  open,
  onToggle,
  draft,
  onDraftChange,
  keyState,
  probed,
  override,
  pending,
  result,
  error,
  notice,
  onSave,
  onTest,
  onSetDefault,
  onRemove,
  onResetContext,
  onUseRegisteredModel,
  onDropRegisteredModel,
  revealEpoch
}: ProviderRowProps): React.JSX.Element {
  /**
   * 只影响这个输入框的临时显示：默认掩码，切换不落草稿、不落盘、不进状态/日志。
   * 显隐只属于"这一次展开 + 这个复位序号"：收起、切到别的 provider（父级展开另一行）、
   * 开始保存 / 保存成功（父级 +1）都立即回到掩码；已存密钥只在用户显式点眼睛时临时回显，
   * 由 SecretField 在 visible 复位时立即清掉（见 SecretField 的 reveal 状态）。
   */
  const [reveal, setReveal] = useState({ open, epoch: revealEpoch, visible: false })
  if (reveal.open !== open || reveal.epoch !== revealEpoch) {
    setReveal({ open, epoch: revealEpoch, visible: false })
  }
  const keyVisible = reveal.visible
  // 已有密钥（且这台机器读得到）：掩码态给圆点占位。needsReentry 不算"可用"，不给圆点。
  const savedKey = keyState?.hasKey === true && keyState.needsReentry !== true
  const keyInputId = `provider-${provider.id}-key-input`
  // 密钥状态未知时按"有密钥"算（读不到宁可不说；配置层面的缺项照报）。
  // 另外 openai 兼容渠道本来就不把"没有密钥"算缺项（本机 / 自建端点常这样，见 providerKeyOptional）
  const problems = providerConfigProblems(provider, keyState === undefined ? true : keyState.hasKey)
  const vision = visionOf(provider.model, probed)
  const source = contextWindowSourceOf(probed, override)
  const modelLabel = displayNameOf(provider.model, override)
  // 这条端点注册了几个模型（001）：多于一个时行上顺带说一句，用户知道自己加过什么。
  // 读的是**草稿**（摘掉 / 加进去立刻反映；草稿没动过时与落盘值完全一致）
  const registered = registeredModelsOf({ model: draft.model, models: draft.models }).filter(
    (model) => model !== ''
  )
  /**
   * 已注册清单的「管理」菜单（001 的闭环）：在几个模型之间**切换**、以及把多余的**摘掉**。
   * 当前选中的那一个不给摘——`registeredModelsOf` 一定会把当前模型补进清单，摘了也是白摘。
   */
  const activeModel = draft.model.trim()
  const registeredItems: MenuEntry[] = registered.flatMap((name) => [
    {
      id: `use:${name}`,
      label: `选用 ${name}`,
      testId: `provider-${provider.id}-use-model-${name}`,
      onSelect: () => onUseRegisteredModel(name)
    },
    ...(name === activeModel
      ? []
      : [
          {
            id: `drop:${name}`,
            label: `从清单移除 ${name}`,
            testId: `provider-${provider.id}-drop-model-${name}`,
            onSelect: () => onDropRegisteredModel(name)
          }
        ])
  ])

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
          {modelLabel.length === 0 ? null : (
            <span className="min-w-0 truncate text-b2 text-ink-secondary">{modelLabel}</span>
          )}
        </span>

        <span className="flex shrink-0 items-baseline gap-1 text-c1 text-ink-secondary">
          <span data-testid={`provider-${provider.id}-context`}>
            {formatTokens(contextWindowOf(provider.model, probed, override))}
          </span>
          {/* 006：这个数字是哪来的，必须写在数字旁边（回退 ≠ 实测） */}
          <span
            data-testid={`provider-${provider.id}-context-source`}
            className="text-ink-tertiary"
          >
            {CONTEXT_WINDOW_SOURCE_LABELS[source]}
          </span>
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
          <div
            data-testid={`provider-${provider.id}-identity`}
            className="grid grid-cols-1 gap-3 sm:grid-cols-2"
          >
            <label className="flex flex-col gap-1 sm:col-span-2">
              <span className="text-b2 text-ink-secondary">渠道名称</span>
              <Input
                data-testid={`provider-${provider.id}-name`}
                value={draft.name}
                onChange={(event) => onDraftChange({ name: event.target.value })}
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-b2 text-ink-secondary">模型名称</span>
              <Input
                data-testid={`provider-${provider.id}-display-name`}
                value={draft.displayName}
                onChange={(event) => onDraftChange({ displayName: event.target.value })}
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-b2 text-ink-secondary">模型 ID</span>
              <Input
                data-testid={`provider-${provider.id}-model`}
                value={draft.model}
                onChange={(event) => onDraftChange({ model: event.target.value })}
              />
            </label>
          </div>

          {registered.length <= 1 ? null : (
            <div className="flex flex-wrap items-center gap-2 text-c1 text-ink-tertiary">
              <span data-testid={`provider-${provider.id}-registered-models`}>
                这条端点已注册 {registered.length} 个模型：{registered.join('、')}
              </span>
              {/* 001 的闭环：清单要能切换、也要能摘（不然改错一个名字就永远留在上面） */}
              <Menu
                align="start"
                items={registeredItems}
                trigger={
                  <Button
                    size="sm"
                    variant="ghost"
                    data-testid={`provider-${provider.id}-registered-menu`}
                  >
                    管理
                  </Button>
                }
              />
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label
              className={cn(
                'flex flex-col gap-1',
                provider.type === 'openai-compatible' ? undefined : 'sm:col-span-2'
              )}
            >
              <span className="flex items-baseline justify-between gap-2 text-b2 text-ink-secondary">
                <span>上下文长度（tokens）</span>
                <span
                  data-testid={`provider-${provider.id}-context-window-source`}
                  className="text-c1 text-ink-tertiary"
                >
                  {CONTEXT_WINDOW_SOURCE_LABELS[source]}
                </span>
              </span>
              <Input
                inputMode="numeric"
                data-testid={`provider-${provider.id}-context-window`}
                value={draft.contextWindow}
                onChange={(event) => onDraftChange({ contextWindow: event.target.value })}
              />
              <span className="flex items-center gap-2 text-c1 text-ink-tertiary">
                <span>实测/回退值：{formatTokens(contextWindowOf(provider.model, probed))}</span>
                {override?.contextWindow === undefined ? null : (
                  <Button
                    size="sm"
                    variant="ghost"
                    data-testid={`provider-${provider.id}-reset-context`}
                    onClick={onResetContext}
                  >
                    恢复探测值
                  </Button>
                )}
              </span>
            </label>

            {provider.type === 'openai-compatible' ? (
              <label className="flex flex-col gap-1">
                <span className="text-b2 text-ink-secondary">Base URL</span>
                <Input
                  data-testid={`provider-${provider.id}-base-url`}
                  value={draft.baseUrl}
                  onChange={(event) => onDraftChange({ baseUrl: event.target.value })}
                />
              </label>
            ) : null}
          </div>

          <div className="flex flex-col gap-1">
            {/* label 不包住眼睛按钮：按钮不参与 label 激活，点击只做显隐（组件内还会把焦点送回输入框） */}
            <label htmlFor={keyInputId} className="text-b2 text-ink-secondary">
              API Key
            </label>
            <SecretField
              id={keyInputId}
              testId={`provider-${provider.id}-key`}
              toggleTestId={`provider-${provider.id}-key-toggle`}
              value={draft.key}
              onValueChange={(key) => onDraftChange({ key })}
              visible={keyVisible}
              onVisibleChange={(visible) => setReveal((current) => ({ ...current, visible }))}
              saved={savedKey}
              providerId={provider.id}
            />
            <span
              data-testid={`provider-${provider.id}-key-status`}
              className="text-c1 text-ink-tertiary"
            >
              {keyStatusText(keyState)}
            </span>
          </div>

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
            <div
              data-testid={`provider-${provider.id}-test-result`}
              className="flex flex-col gap-1 text-c1 text-ink-secondary"
            >
              <p>{connectionTestHeadline(result)}</p>
              {/* 有哪一步不是"通过"时，主进程把那一步的原因放在 message 里——原样显示，不吞 */}
              {result.message === undefined ? null : (
                <p
                  data-testid={`provider-${provider.id}-test-message`}
                  className="text-ink-secondary"
                >
                  {result.message}
                </p>
              )}
              <ul className="flex flex-col gap-0.5 text-ink-tertiary">
                {result.steps.map((step) => (
                  <li key={step.id} data-testid={`provider-${provider.id}-test-step-${step.id}`}>
                    {CONNECTION_TEST_STEP_LABELS[step.id]}：
                    {CONNECTION_TEST_STATUS_LABELS[step.status]}
                    {step.latencyMs === undefined ? '' : `（${step.latencyMs} ms）`} ——{' '}
                    {step.detail}
                  </li>
                ))}
              </ul>
              {/* 005：验证范围必须写在结果旁边——"通过"不等于"全工具表在生产里都兼容" */}
              <p data-testid={`provider-${provider.id}-test-scope`} className="text-ink-tertiary">
                {result.scopeNote}
              </p>
            </div>
          ) : null}

          {notice === undefined ? null : (
            <p
              data-testid={`provider-${provider.id}-notice`}
              role="status"
              className="text-c1 text-ink-secondary"
            >
              {notice}
            </p>
          )}

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
