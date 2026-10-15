import { unwrapIpcError } from '@renderer/lib/ipc-error'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Chip } from '@renderer/components/ui/chip'
import { Input } from '@renderer/components/ui/input'
import { Switch } from '@renderer/components/ui/switch'
import { useSettingsStore } from '@renderer/lib/settings-store'
import type { ProviderKeyState } from '@shared/providers'
import {
  effectiveReasoningTranslate,
  REASONING_TRANSLATE_MODES,
  REASONING_TRANSLATE_PRESET,
  type ReasoningTranslateMode
} from '@shared/settings'

/**
 * 设置页「模型」栏的「思考翻译」组（round 32）：开关 + 回显模式 + 翻译服务三项 + 目标语言。
 *
 * 分工（与「追踪」/「记忆」同一套）：开关、模式、服务地址、模型、目标语言是普通设置，
 * 经 settings:update 落 settings.json；可选 API Key 只经 translate:set-key 写方向过一次
 * （主进程 safeStorage 落 secrets.json），读回来只有"有没有 / 要不要重录"。
 *
 * 预置：服务地址与模型预置成用户局域网那台（REASONING_TRANSLATE_PRESET）——**读盘为空时表单按预置填，
 * 读盘不静默改写**（用户清空保存就是清空，同语义召回的预置口径；"生效值"由
 * shared/settings 的 effectiveReasoningTranslate 统一兜底，主进程用的是同一份）。
 * 模式二选一当场生效（与召回来源那对 chip 同口径）；地址/模型/目标语言改完点「保存」。
 *
 * UI 从简：零 emoji、无小字解释、控件自绘；三项只在开关打开时出现。
 */
interface Draft {
  baseUrl: string
  model: string
  targetLanguage: string
  /** 待写入的新密钥；保存成功后立刻清空（已存的密钥不回显） */
  key: string
}

/** 模式文案的唯一出处（顺序 = shared/settings 里枚举的顺序） */
const MODE_LABELS: Record<ReasoningTranslateMode, string> = {
  full: '全量翻译',
  button: '翻译按钮'
}

function messageOf(error: unknown): string {
  return unwrapIpcError(error)
}

export function ReasoningTranslateSettings(): React.JSX.Element {
  const settings = useSettingsStore((state) => state.settings.reasoningTranslate)
  const saveReasoningTranslate = useSettingsStore((state) => state.saveReasoningTranslate)

  const [draft, setDraft] = useState<Draft | undefined>(undefined)
  const [keyState, setKeyState] = useState<ProviderKeyState | null>(null)
  const [pending, setPending] = useState<'saving' | 'clearing' | 'toggling' | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  /** 上一次动作的结果（保存 / 清除密钥都在这行说话；012 用户口径） */
  const [notice, setNotice] = useState('')

  const translateApi = window.kyclaw?.translate

  useEffect(() => {
    const api = translateApi
    if (!api) return
    let alive = true
    api.keyState().then(
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
    // translateApi 是 preload 注入的常量桥；重挂一次读一次即可
  }, [translateApi])

  const effective = useMemo(() => effectiveReasoningTranslate(settings), [settings])

  /** 表单值 = 草稿（用户改过就是它）或落盘值；落盘为空串时按预置填（见文件头） */
  const current: Draft = useMemo(
    () =>
      draft ?? {
        baseUrl: effective.baseUrl,
        model: effective.model,
        targetLanguage: effective.targetLanguage,
        key: ''
      },
    [draft, effective.baseUrl, effective.model, effective.targetLanguage]
  )

  const patchDraft = (patch: Partial<Draft>): void => {
    setDraft({ ...current, ...patch })
    // 012：输入一动，上一次动作留下的「已保存」就不再描述眼前这份内容
    setNotice('')
  }

  const save = useCallback(async (): Promise<void> => {
    const baseUrl = current.baseUrl.trim()
    const model = current.model.trim()
    const targetLanguage = current.targetLanguage.trim()
    const key = current.key.trim()

    setError(undefined)
    setNotice('')
    setPending('saving')
    try {
      await saveReasoningTranslate({ baseUrl, model, targetLanguage })
      if (key.length > 0) {
        if (!translateApi) throw new Error('翻译通道不可用（window.kyclaw 缺失），密钥没有保存')
        await translateApi.setKey(key)
        setKeyState(await translateApi.keyState())
      }
      setDraft(undefined)
      setNotice('已保存')
    } catch (caught) {
      setError(messageOf(caught))
    } finally {
      setPending(undefined)
    }
  }, [current, saveReasoningTranslate, translateApi])

  const clearKey = useCallback(async (): Promise<void> => {
    if (!translateApi) {
      setError('翻译通道不可用（window.kyclaw 缺失），密钥没有清除')
      return
    }
    setPending('clearing')
    setError(undefined)
    setNotice('')
    try {
      setKeyState(await translateApi.clearKey())
      setNotice('密钥已清除')
    } catch (caught) {
      setError(messageOf(caught))
    } finally {
      setPending(undefined)
    }
  }, [translateApi])

  /**
   * **就地落盘**（开关 / 翻译方式）：`pending` 要等下一次渲染才生效，连点两下会并发发两次
   * settings:update —— 用一个 ref 现读的锁把这段串起来（期间控件 disabled）。
   */
  const writing = useRef(false)
  const patch = useCallback(
    async (next: Parameters<typeof saveReasoningTranslate>[0]): Promise<void> => {
      if (writing.current) return
      writing.current = true
      setPending('toggling')
      setError(undefined)
      setNotice('')
      try {
        await saveReasoningTranslate(next)
      } catch (caught) {
        setError(messageOf(caught))
      } finally {
        writing.current = false
        setPending(undefined)
      }
    },
    [saveReasoningTranslate]
  )

  const busy = pending !== undefined

  return (
    <div data-testid="reasoning-translate-settings" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-b2 text-ink">启用思考翻译</span>
        <Switch
          checked={settings.enabled}
          label="启用思考翻译"
          data-testid="translate-enabled"
          disabled={busy}
          onCheckedChange={(next) => void patch({ enabled: next })}
        />
      </div>

      {settings.enabled ? (
        <>
          <div className="flex flex-col gap-2">
            <span className="text-b2 text-ink-secondary">翻译方式</span>
            <div role="group" aria-label="翻译方式" className="flex flex-wrap gap-3">
              {REASONING_TRANSLATE_MODES.map((mode) => (
                <Chip
                  key={mode}
                  data-testid={`translate-mode-${mode}`}
                  aria-pressed={settings.mode === mode}
                  className={settings.mode === mode ? 'bg-selected' : undefined}
                  disabled={busy}
                  onClick={() => void patch({ mode })}
                >
                  {MODE_LABELS[mode]}
                </Chip>
              ))}
            </div>
          </div>

          <label className="flex flex-col gap-1">
            <span className="text-b2 text-ink-secondary">服务地址</span>
            <Input
              data-testid="translate-base-url"
              value={current.baseUrl}
              placeholder={REASONING_TRANSLATE_PRESET.baseUrl}
              disabled={busy}
              onChange={(event) => patchDraft({ baseUrl: event.target.value })}
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-b2 text-ink-secondary">模型</span>
            <Input
              data-testid="translate-model"
              value={current.model}
              placeholder={REASONING_TRANSLATE_PRESET.model}
              disabled={busy}
              onChange={(event) => patchDraft({ model: event.target.value })}
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-b2 text-ink-secondary">API Key</span>
            <Input
              type="password"
              autoComplete="off"
              data-testid="translate-api-key"
              value={current.key}
              placeholder={keyState?.hasKey === true ? '已保存；要换就填新的' : '本机服务留空即可'}
              disabled={busy}
              onChange={(event) => patchDraft({ key: event.target.value })}
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-b2 text-ink-secondary">目标语言</span>
            <Input
              data-testid="translate-target-language"
              value={current.targetLanguage}
              placeholder={REASONING_TRANSLATE_PRESET.targetLanguage}
              disabled={busy}
              onChange={(event) => patchDraft({ targetLanguage: event.target.value })}
            />
          </label>

          {keyState?.needsReentry === true ? (
            <p data-testid="translate-reentry" className="text-c1 text-ink-secondary">
              已存的密钥在这台机器上读不到，请重新录入。
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-3">
            <Button
              size="sm"
              data-testid="translate-save"
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
                data-testid="translate-clear-key"
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

      {notice === '' ? null : (
        <p data-testid="translate-notice" role="status" className="text-c1 text-ink-secondary">
          {notice}
        </p>
      )}

      {error === undefined ? null : (
        <p data-testid="translate-error" className="text-c1 text-danger">
          {error}
        </p>
      )}
    </div>
  )
}
