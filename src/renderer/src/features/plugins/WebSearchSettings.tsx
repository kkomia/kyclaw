import { unwrapIpcError } from '@renderer/lib/ipc-error'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Chip } from '@renderer/components/ui/chip'
import { Input } from '@renderer/components/ui/input'
import { useSettingsStore } from '@renderer/lib/settings-store'
import type { ProviderKeyState } from '@shared/providers'
import {
  effectiveWebSearch,
  SEARCH_PROVIDERS,
  WEB_SEARCH_MODES,
  WEB_SEARCH_PRESET,
  type SearchKeyTarget,
  type SearchProvider,
  type WebSearchMode
} from '@shared/search'
import type { SearchKeyStates } from '@shared/ipc'

/**
 * 内置插件「联网搜索」的设置面（round 45 在设置页「模型」栏，round 48 随插件页的
 * 内置插件条目搬到 features/plugins/；**testid 与 IPC 调用一律不动**）：
 * 后端模式 + 服务商 + 两个服务地址 + 三个可选 Key。
 *
 * 分工（与「思考翻译」/「记忆」同一套）：模式、服务商、两个地址是普通设置，经 settings:update
 * 落 settings.json；三个可选 Key（Exa / Tavily / Jina）只经 search:set-key 写方向过一次
 * （主进程 safeStorage 落 secrets.json），读回来只有"有没有 / 要不要重录"。
 *
 * 预置：免费档（Exa MCP，无需 Key）是缺省 —— 装好就能用；想升级配额与稳定性再填自己的 Key。
 * 两个地址是预置项：**读盘为空时表单按预置填，读盘不静默改写**（口径同语义召回/思考翻译）。
 *
 * UI 从简：零 emoji、无小字解释、控件自绘；Key 输入只在对应档位出现。
 */
interface Draft {
  exaEndpoint: string
  readerEndpoint: string
  /** 待写入的新密钥；保存成功后立刻清空（已存的密钥不回显） */
  exaKey: string
  tavilyKey: string
  jinaKey: string
}

/** 模式文案的唯一出处（顺序 = shared/search 里枚举的顺序） */
const MODE_LABELS: Record<WebSearchMode, string> = {
  free: '免费档（Exa，无需 Key）',
  custom: '自定义 Key'
}

const PROVIDER_LABELS: Record<SearchProvider, string> = {
  exa: 'Exa',
  tavily: 'Tavily'
}

function messageOf(error: unknown): string {
  return unwrapIpcError(error)
}

/** 密钥状态还没读到时的显示：不猜"未配置"（免得一闪而过的误报） */
function keyStatusText(state: ProviderKeyState | undefined): string {
  if (!state) return '读取中…'
  if (state.needsReentry) return '需要重新录入'
  return state.hasKey ? '已配置' : '未配置'
}

/** 三档 Key 的草稿字段名（target 与表单字段一一对应） */
const KEY_FIELD: Record<SearchKeyTarget, keyof Draft> = {
  exa: 'exaKey',
  tavily: 'tavilyKey',
  jina: 'jinaKey'
}

export function WebSearchSettings(): React.JSX.Element {
  const settings = useSettingsStore((state) => state.settings.webSearch)
  const saveWebSearch = useSettingsStore((state) => state.saveWebSearch)

  const [draft, setDraft] = useState<Draft | undefined>(undefined)
  const [keyStates, setKeyStates] = useState<SearchKeyStates | null>(null)
  const [pending, setPending] = useState<'saving' | SearchKeyTarget | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)

  const searchApi = window.kyclaw?.search

  useEffect(() => {
    const api = searchApi
    if (!api) return
    let alive = true
    api.keyStates().then(
      (next) => {
        if (alive) setKeyStates(next)
      },
      (caught: unknown) => {
        if (alive) setError(messageOf(caught))
      }
    )
    return () => {
      alive = false
    }
    // searchApi 是 preload 注入的常量桥；重挂一次读一次即可
  }, [searchApi])

  const effective = useMemo(() => effectiveWebSearch(settings), [settings])

  /** 表单值 = 草稿（用户改过就是它）或落盘值；落盘为空串时按预置填（见文件头） */
  const current: Draft = useMemo(
    () =>
      draft ?? {
        exaEndpoint: effective.exaEndpoint,
        readerEndpoint: effective.readerEndpoint,
        exaKey: '',
        tavilyKey: '',
        jinaKey: ''
      },
    [draft, effective.exaEndpoint, effective.readerEndpoint]
  )

  const patchDraft = (patch: Partial<Draft>): void => {
    setDraft({ ...current, ...patch })
  }

  const clearKey = useCallback(
    async (target: SearchKeyTarget): Promise<void> => {
      if (!searchApi) {
        setError('搜索通道不可用（window.kyclaw 缺失），密钥没有清除')
        return
      }
      setPending(target)
      setError(undefined)
      try {
        setKeyStates(await searchApi.clearKey(target))
      } catch (caught) {
        setError(messageOf(caught))
      } finally {
        setPending(undefined)
      }
    },
    [searchApi]
  )

  const save = useCallback(async (): Promise<void> => {
    const exaEndpoint = current.exaEndpoint.trim()
    const readerEndpoint = current.readerEndpoint.trim()

    setError(undefined)
    setPending('saving')
    try {
      await saveWebSearch({ exaEndpoint, readerEndpoint })
      const drafts: Array<[SearchKeyTarget, string]> = [
        ['exa', current.exaKey.trim()],
        ['tavily', current.tavilyKey.trim()],
        ['jina', current.jinaKey.trim()]
      ]
      const written = drafts.filter(([, key]) => key.length > 0)
      if (written.length > 0) {
        if (!searchApi) throw new Error('搜索通道不可用（window.kyclaw 缺失），密钥没有保存')
        for (const [target, key] of written) await searchApi.setKey(target, key)
        setKeyStates(await searchApi.keyStates())
      }
      setDraft(undefined)
    } catch (caught) {
      setError(messageOf(caught))
    } finally {
      setPending(undefined)
    }
  }, [current, saveWebSearch, searchApi])

  const patch = (next: Parameters<typeof saveWebSearch>[0]): void => {
    setError(undefined)
    saveWebSearch(next).catch((caught: unknown) => setError(messageOf(caught)))
  }

  const busy = pending !== undefined

  /** 一档可选 Key 的输入行（标签 + 密码框 + 状态 + 清除）；只在用得上的档位出现 */
  const keyField = (
    target: SearchKeyTarget,
    label: string,
    placeholder: string
  ): React.JSX.Element => {
    const state = keyStates?.[target]
    return (
      <div className="flex flex-col gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-b2 text-ink-secondary">{label}</span>
          <Input
            type="password"
            autoComplete="off"
            data-testid={`web-search-${target}-key`}
            value={String(current[KEY_FIELD[target]])}
            placeholder={state?.hasKey === true ? '已保存；要换就填新的' : placeholder}
            disabled={busy}
            onChange={(event) => patchDraft({ [KEY_FIELD[target]]: event.target.value })}
          />
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <span
            data-testid={`web-search-${target}-key-status`}
            className="text-c1 text-ink-tertiary"
          >
            {keyStatusText(state)}
          </span>
          {state?.hasKey === true ? (
            <Button
              size="sm"
              variant="ghost"
              data-testid={`web-search-${target}-clear`}
              loading={pending === target}
              disabled={busy && pending !== target}
              onClick={() => void clearKey(target)}
            >
              清除密钥
            </Button>
          ) : null}
        </div>
        {state?.needsReentry === true ? (
          <p data-testid={`web-search-${target}-reentry`} className="text-c1 text-ink-secondary">
            已存的密钥在这台机器上读不到，请重新录入。
          </p>
        ) : null}
      </div>
    )
  }

  return (
    <div data-testid="web-search-settings" className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <span className="text-b2 text-ink-secondary">搜索后端</span>
        <div role="group" aria-label="搜索后端" className="flex flex-wrap gap-3">
          {WEB_SEARCH_MODES.map((mode) => (
            <Chip
              key={mode}
              data-testid={`web-search-mode-${mode}`}
              aria-pressed={settings.mode === mode}
              className={settings.mode === mode ? 'bg-selected' : undefined}
              disabled={busy}
              onClick={() => patch({ mode })}
            >
              {MODE_LABELS[mode]}
            </Chip>
          ))}
        </div>
      </div>

      {settings.mode === 'custom' ? (
        <div className="flex flex-col gap-2">
          <span className="text-b2 text-ink-secondary">服务商</span>
          <div role="group" aria-label="服务商" className="flex flex-wrap gap-3">
            {SEARCH_PROVIDERS.map((provider) => (
              <Chip
                key={provider}
                data-testid={`web-search-provider-${provider}`}
                aria-pressed={settings.provider === provider}
                className={settings.provider === provider ? 'bg-selected' : undefined}
                disabled={busy}
                onClick={() => patch({ provider })}
              >
                {PROVIDER_LABELS[provider]}
              </Chip>
            ))}
          </div>
        </div>
      ) : null}

      {settings.mode === 'custom'
        ? keyField(
            settings.provider,
            `${PROVIDER_LABELS[settings.provider]} API Key`,
            settings.provider === 'exa' ? 'Exa API Key' : 'Tavily API Key'
          )
        : null}

      <label className="flex flex-col gap-1">
        <span className="text-b2 text-ink-secondary">搜索服务地址（Exa）</span>
        <Input
          data-testid="web-search-exa-endpoint"
          value={current.exaEndpoint}
          placeholder={WEB_SEARCH_PRESET.exaEndpoint}
          disabled={busy}
          onChange={(event) => patchDraft({ exaEndpoint: event.target.value })}
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-b2 text-ink-secondary">正文阅读服务地址</span>
        <Input
          data-testid="web-search-reader-endpoint"
          value={current.readerEndpoint}
          placeholder={WEB_SEARCH_PRESET.readerEndpoint}
          disabled={busy}
          onChange={(event) => patchDraft({ readerEndpoint: event.target.value })}
        />
      </label>

      {keyField('jina', 'Jina API Key（正文阅读，可选）', '不填也能用免费档')}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          data-testid="web-search-save"
          loading={pending === 'saving'}
          disabled={busy && pending !== 'saving'}
          onClick={() => void save()}
        >
          保存
        </Button>
      </div>

      {error === undefined ? null : (
        <p data-testid="web-search-error" className="text-c1 text-danger">
          {error}
        </p>
      )}
    </div>
  )
}
