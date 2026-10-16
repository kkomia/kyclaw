import { cn } from '@renderer/components/ui/cn'
import { Button } from '@renderer/components/ui/button'
import { Chip } from '@renderer/components/ui/chip'
import { Input } from '@renderer/components/ui/input'
import { Switch } from '@renderer/components/ui/switch'
import { unwrapIpcError } from '@renderer/lib/ipc-error'
import { fetchRecallStatus } from '@renderer/lib/memory-api'
import { useSettingsStore } from '@renderer/lib/settings-store'
import type { RecallStatus } from '@shared/memory'
import type { ProviderKeyState } from '@shared/providers'
import {
  SEMANTIC_RECALL_PRESET,
  SEMANTIC_RECALL_SOURCES,
  type SemanticRecallSettings
} from '@shared/settings'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LocalModelSettings } from './LocalModelSettings'
import { recallStatusText } from './status-text'

/**
 * 设置页「记忆」栏的语义召回组（round 28 模块 3）：**历史检索**（嵌入服务 / 本机引擎）。
 * round 58 起召回是 **thread 作用域**（只在本会话里找，见 mastra/index.ts）——所以说到范围就说
 * "本会话早先的消息"；下面的记忆面板同理，看的是当前会话那一份。
 *
 * 本轮（设置页重组）：**默认只露开关 + 本次运行的真实状态 + 一句说明**；嵌入来源、服务地址、
 * 模型、密钥、本地模型与「保存」全收进「配置」后面的展开区（默认收起，与「追踪」栏同一手势）。
 * 常显的那两件不可省：关掉是**就地落盘**（writeInPlace，不留草稿），收起配置也能关掉，
 * 关不关不依赖那颗被收起来的「保存」；状态行说的是"这次运行真挂上没有"，收起时也得看得见。
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
 * 这一栏只管**历史检索**：关掉 / 换配置都不会关闭或清除当前会话的记忆 —— Memory 照常带着
 * storage + workingMemory + lastMessages 装起来，没有 embedder 只是不做召回（mastra/index.ts）。
 * 那句说明就写在开关下面（recall-scope-note），别让它被读成"整个记忆的总开关"。
 *
 * 嵌入来源（模块 3B）：`remote` = 展开区里的服务地址/模型/密钥；`localEngine` = 「本地模型」组
 * （本机引擎 + 下载到本机的 GGUF，见 LocalModelSettings）。两组互斥显示，来源本身是个普通设置值，
 * **不跟开关一起消失**（关着也能先把服务/模型配好）。
 *
 * 两行不收进展开区：密钥读不到（换机/迁移 —— 要用户动手）与上一次动作的结果（刚发生那件事的回执），
 * 与「追踪」栏同一条口径：收起配置时它们还看得见。
 */
interface Draft {
  baseUrl: string
  model: string
  key: string
}

/** 嵌入来源的显示名（枚举值的唯一文案出处） */
const SOURCE_LABELS: Record<(typeof SEMANTIC_RECALL_SOURCES)[number], string> = {
  remote: '嵌入服务',
  localEngine: '本机引擎'
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

/** 一行状态文字（记忆页复用）：说清"本次运行开没开" */
export function RecallStatusLine({ className }: { className?: string }): React.JSX.Element {
  const enabled = useSettingsStore((state) => state.settings.semanticRecall.enabled)
  const { status, error } = useRecallStatus()

  return (
    <p
      data-testid="recall-status"
      className={cn('text-b2 text-ink-secondary', className)}
      title={error}
    >
      语义召回：{error === undefined ? recallStatusText(status, enabled) : error}
    </p>
  )
}

export function RecallSettings(): React.JSX.Element {
  const settings = useSettingsStore((state) => state.settings.semanticRecall)
  const saveSemanticRecall = useSettingsStore((state) => state.saveSemanticRecall)

  const { status, error: statusError, refresh } = useRecallStatus()
  const [draft, setDraft] = useState<Draft | undefined>(undefined)
  const [keyState, setKeyState] = useState<ProviderKeyState | null>(null)
  const [pending, setPending] = useState<'saving' | 'clearing' | 'toggling' | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  /** 上一次动作的结果（保存 / 清除密钥都在这行说话；012 用户口径） */
  const [notice, setNotice] = useState('')
  /** 配置区的展开状态：默认收起（本轮 —— 默认只露开关、状态行与一句说明） */
  const [expanded, setExpanded] = useState(false)

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
    // 012：输入一动，上一次动作留下的「已保存」就不再描述眼前这份内容
    setNotice('')
  }

  /**
   * **就地落盘**（开关 / 嵌入来源；与「追踪」栏同一手法）：`pending` 要等下一次渲染才生效，
   * 连点两下会并发发两次 settings:update —— 用一个 ref 现读的锁把这段串起来（期间控件 disabled）。
   */
  const writing = useRef(false)
  const writeInPlace = useCallback(
    async (patch: Partial<SemanticRecallSettings>): Promise<void> => {
      if (writing.current) return
      writing.current = true
      setPending('toggling')
      setError(undefined)
      setNotice('')
      try {
        await saveSemanticRecall(patch)
      } catch (caught) {
        setError(messageOf(caught))
      } finally {
        writing.current = false
        setPending(undefined)
      }
    },
    [saveSemanticRecall]
  )

  const save = useCallback(async (): Promise<void> => {
    const baseUrl = current.baseUrl.trim()
    const model = current.model.trim()
    const key = current.key.trim()

    setError(undefined)
    setNotice('')
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
      setNotice('已保存')
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
    setNotice('')
    try {
      setKeyState(await memoryApi.clearEmbeddingKey())
      setNotice('密钥已清除')
    } catch (caught) {
      setError(messageOf(caught))
    } finally {
      setPending(undefined)
    }
  }, [memoryApi])

  const toggle = (next: boolean): void => void writeInPlace({ enabled: next })

  const busy = pending !== undefined

  /** 状态行那句话：设置值与运行事实不一致时由设置值说话（规则见 status-text.ts） */
  const statusText =
    statusError === undefined ? recallStatusText(status, settings.enabled) : statusError

  return (
    <div data-testid="recall-settings" className="flex flex-col gap-3">
      {/* 三行的紧凑行（返工）：①标题 + 动作（「配置」与开关，与其他行的「动作在右」同一套）
          ②本次运行的真实状态 ③一句范围说明。后两行 4px 紧跟标题行，整行外面由卡片给内边距。
          开关与状态都不收进展开区：关掉是**就地落盘**（收起时也关得掉），"这次运行真挂上没有"
          这句话收起时照样看得见 */}
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-b2 text-ink">语义召回</span>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              data-testid="recall-config-toggle"
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? '收起' : '配置'}
            </Button>
            <Switch
              checked={settings.enabled}
              label="语义召回"
              data-testid="recall-enabled"
              disabled={busy}
              onCheckedChange={toggle}
            />
          </div>
        </div>

        <p
          data-testid="recall-settings-status"
          className="text-c1 text-ink-secondary"
          title={statusError}
        >
          状态：{statusText}
        </p>

        {/* 一句说明（用户口径）：这一项只管"从历史里找"，不是整个记忆的总开关 ——
            关掉/换配置都不会关闭或清除当前会话的记忆。
            生效时机写在常显的话里（别让它被读成"关掉当场就停"）：这一栏的装配只在应用启动时做一次 */}
        <p data-testid="recall-scope-note" className="text-c1 text-ink-secondary">
          只影响历史检索：关掉后不再从本会话早先的消息里找相关内容（重启应用后生效），不会关闭或清除当前会话的记忆。
        </p>
      </div>

      {/* 密钥读不到（换机/迁移）是要用户动手的事：不收进展开区（收起时也看得见；同「追踪」栏） */}
      {keyState?.needsReentry === true ? (
        <p data-testid="recall-reentry" className="text-c1 text-ink-secondary">
          已存的密钥在这台机器上读不到，请重新录入。
        </p>
      ) : null}

      {expanded ? (
        <>
          {/* 嵌入来源（模块 3B）：服务 = 任意 OpenAI 兼容端点；本机引擎 = 下载到本机的 GGUF + 子进程。
              换来源要重启应用才生效（装配只在启动时做一次），状态行说的是"本次运行开没开"。
              来源与下面几项都是"配置"，与开关无关：关着也能先把服务/模型配好（不再跟着开关消失） */}
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-b2 text-ink-secondary">嵌入来源</span>
            <div role="group" aria-label="嵌入来源" className="flex flex-wrap gap-3">
              {SEMANTIC_RECALL_SOURCES.map((source) => (
                <Chip
                  key={source}
                  data-testid={`recall-source-${source}`}
                  aria-pressed={settings.source === source}
                  className={cn(settings.source === source && 'bg-selected')}
                  disabled={busy}
                  onClick={() => void writeInPlace({ source })}
                >
                  {SOURCE_LABELS[source]}
                </Chip>
              ))}
            </div>
          </div>

          {settings.source === 'localEngine' ? <LocalModelSettings /> : null}

          {settings.source === 'remote' ? (
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

              {/* 生效时机（口径不变）：装配只在启动时做一次 —— 保存是"落盘"，不是"当场换掉" */}
              <p data-testid="recall-restart-note" className="text-c1 text-ink-secondary">
                保存后重启应用才生效；开关也一样（本次运行的状态看上面那行）。
              </p>

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
        </>
      ) : null}

      {notice === '' ? null : (
        <p data-testid="recall-notice" role="status" className="text-c1 text-ink-secondary">
          {notice}
        </p>
      )}

      {error === undefined ? null : (
        <p data-testid="recall-error" className="text-c1 text-danger">
          {error}
        </p>
      )}
    </div>
  )
}
