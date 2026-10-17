import { Button } from '@renderer/components/ui/button'
import { Chip } from '@renderer/components/ui/chip'
import { cn } from '@renderer/components/ui/cn'
import { unwrapIpcError } from '@renderer/lib/ipc-error'
import {
  cancelLocalModelDownload,
  downloadLocalModel,
  fetchLocalModels,
  onLocalModelsChanged,
  pickCustomLocalModel,
  removeLocalModel,
  selectLocalModel
} from '@renderer/lib/local-models-api'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { formatBytes, type LocalModelsOverview } from '@shared/local-models'
import { LOCAL_ENGINE_IDLE_OPTIONS } from '@shared/settings'
import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * 设置页「记忆」栏的「本地模型」组（模块 3B）：本机嵌入引擎的模型清单与下载管理。
 *
 * 三块：
 *   1. **当前 + 引擎**：现在用的哪个模型、引擎进程什么状态（未启动 / 启动中 / 运行中 / 出错）；
 *   2. **清单**：推荐档一行一个（体积、来源、当前），可下载（带进度条）/ 取消 / 使用 / 删除；
 *   3. **自定义 GGUF**：走原生选择器挑本机自备的模型文件（取消 = 不改动）；
 *      外加引擎的空闲回收档位（少了它，本机引擎会一直占着几百 MB 到 1GB 的内存）。
 *
 * 生效时机与「追踪」栏同一口径：**引擎和召回在应用启动时装配** —— 这里选完模型会显示
 * "重启应用后启用"，不假装当场生效（状态行不撒谎）。唯一下场生效的是空闲回收档位。
 *
 * 进度是主进程推的（`onLocalModelsChanged`，600MB 级要下载几分钟）：组件挂载时先拉一次，
 * 之后只吃推送。UI 从简：不放解释性小字（雷点 2.1/2.2），进度条有过渡不硬闪（雷点 5）。
 */
function messageOf(error: unknown): string {
  return unwrapIpcError(error)
}

type Pending = string | undefined

function phaseText(overview: LocalModelsOverview, activeSelected: boolean): string {
  switch (overview.engine.phase) {
    case 'running':
      return '运行中'
    case 'starting':
      return '启动中…'
    case 'error':
      return overview.engine.detail === null ? '出错' : `出错：${overview.engine.detail}`
    case 'stopped':
      if (overview.engine.detail !== null) return overview.engine.detail
      // 选好了模型但引擎还没起 = 这一次启动还没装配到它（改设置要重启应用才生效）
      return activeSelected ? '未启动；重启应用后启用' : '未启动'
  }
}

export function LocalModelSettings(): React.JSX.Element {
  const idleMinutes = useSettingsStore((state) => state.settings.semanticRecall.idleMinutes)
  const saveSemanticRecall = useSettingsStore((state) => state.saveSemanticRecall)

  const [overview, setOverview] = useState<LocalModelsOverview | null>(null)
  const [pending, setPending] = useState<Pending>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  /**
   * 每次推送 +1：用来判"我这次动作的返回值是不是已经过期"。
   * 没有它会有两种真会发生的翻车：挂载时那次"拉一把"的旧快照盖掉刚推来的下载进度；
   * 动作回包（同样是旧快照）盖掉动作期间推来的新进度 —— 进度条会往回跳。
   */
  const pushSeq = useRef(0)

  useEffect(() => {
    let alive = true
    fetchLocalModels().then(
      (next) => {
        if (alive && pushSeq.current === 0) setOverview(next)
      },
      (caught: unknown) => {
        if (alive) setError(messageOf(caught))
      }
    )
    const unsubscribe = onLocalModelsChanged((next) => {
      if (!alive) return
      pushSeq.current += 1
      setOverview(next)
    })
    return () => {
      alive = false
      unsubscribe()
    }
  }, [])

  const run = useCallback(
    async (key: string, action: () => Promise<LocalModelsOverview>): Promise<void> => {
      setPending(key)
      setError(undefined)
      const seq = pushSeq.current
      try {
        const next = await action()
        if (pushSeq.current === seq) setOverview(next)
      } catch (caught) {
        setError(messageOf(caught))
      } finally {
        setPending(undefined)
      }
    },
    []
  )

  const activeSelected = overview?.activeId !== null && overview?.activeId !== undefined
  const downloading = overview?.download ?? null
  const busy = pending !== undefined

  return (
    <div data-testid="local-model-settings" className="flex flex-col gap-4">
      <section className="flex flex-wrap items-center gap-3 border-t border-hairline p-3">
        <span className="text-b2 text-ink">本机引擎</span>
        <span
          data-testid="local-engine-model"
          className="min-w-0 flex-1 truncate text-b2 text-ink-secondary"
        >
          {overview === null
            ? '正在读取…'
            : (overview.items.find((item) => item.active)?.name ?? '未选择模型')}
        </span>
        <span data-testid="local-engine-phase" className="text-c1 text-ink-tertiary">
          {overview === null ? '' : phaseText(overview, activeSelected)}
        </span>
      </section>

      {(overview?.items ?? []).map((item) => {
        const progress = downloading !== null && downloading.id === item.id ? downloading : null
        /** 只有"下载中/校验中"才算进行中：取消按钮此时才有意义（已完成/出错走下面正常分支） */
        const activeDownload =
          progress !== null && (progress.phase === 'downloading' || progress.phase === 'verifying')
        const percent =
          progress === null || progress.total === 0
            ? 0
            : Math.min(100, Math.round((progress.received / progress.total) * 100))
        return (
          <section
            key={item.id}
            data-testid={`local-model-${item.id}`}
            className="flex flex-col gap-2 border-t border-hairline p-3"
          >
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-b2 text-ink">{item.name}</span>
              <span className="text-c1 text-ink-tertiary">
                {item.installedBytes !== null
                  ? `${formatBytes(item.installedBytes)} 已占用`
                  : item.custom
                    ? '文件不在'
                    : formatBytes(item.bytes)}
              </span>
              {item.note === '' ? null : (
                <span className="text-c1 text-ink-tertiary">{item.note}</span>
              )}
              {item.active ? (
                <span
                  data-testid={`local-model-${item.id}-active`}
                  className="text-c1 text-accent-text"
                >
                  当前
                </span>
              ) : null}

              <span className="flex-1" />

              {activeDownload ? (
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid={`local-model-${item.id}-cancel`}
                  disabled={busy}
                  onClick={() => void run(`cancel-${item.id}`, cancelLocalModelDownload)}
                >
                  取消
                </Button>
              ) : item.downloaded ? (
                <>
                  <Button
                    size="sm"
                    data-testid={`local-model-${item.id}-use`}
                    disabled={busy || item.active}
                    onClick={() => void run(`select-${item.id}`, () => selectLocalModel(item.id))}
                  >
                    使用
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    data-testid={`local-model-${item.id}-remove`}
                    disabled={busy}
                    onClick={() => void run(`remove-${item.id}`, () => removeLocalModel(item.id))}
                  >
                    删除
                  </Button>
                </>
              ) : item.custom ? (
                // 自定义档的文件不在了：只能"取消选择"（它的 GGUF 是用户自己的，我们不动）
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid={`local-model-${item.id}-remove`}
                  disabled={busy}
                  onClick={() => void run(`remove-${item.id}`, () => removeLocalModel(item.id))}
                >
                  取消选择
                </Button>
              ) : (
                <Button
                  size="sm"
                  data-testid={`local-model-${item.id}-download`}
                  loading={pending === `download-${item.id}`}
                  disabled={busy || downloading !== null}
                  onClick={() => void run(`download-${item.id}`, () => downloadLocalModel(item.id))}
                >
                  下载
                </Button>
              )}
            </div>

            {progress === null ? null : (
              <div className="flex items-center gap-2">
                <div
                  data-testid={`local-model-${item.id}-bar`}
                  role="progressbar"
                  aria-valuenow={percent}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  className="h-1 min-w-0 flex-1 overflow-hidden rounded-pill bg-fill-1"
                >
                  <div
                    className={cn(
                      'h-full rounded-pill bg-accent transition-[width] duration-(--motion-main) ease-main',
                      progress.phase === 'verifying' && 'w-full animate-pulse'
                    )}
                    style={progress.phase === 'verifying' ? undefined : { width: `${percent}%` }}
                  />
                </div>
                <span
                  data-testid={`local-model-${item.id}-percent`}
                  className="text-c1 text-ink-tertiary"
                >
                  {progress.phase === 'verifying'
                    ? '校验中…'
                    : progress.phase === 'done'
                      ? '已完成'
                      : `${percent}%`}
                </span>
              </div>
            )}

            {progress !== null && progress.message !== null ? (
              <p data-testid={`local-model-${item.id}-error`} className="text-c1 text-danger">
                {progress.message}
              </p>
            ) : null}
          </section>
        )
      })}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          data-testid="local-model-pick-custom"
          loading={pending === 'pick-custom'}
          disabled={busy && pending !== 'pick-custom'}
          onClick={() => void run('pick-custom', pickCustomLocalModel)}
        >
          选择本机模型文件
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <span className="text-b2 text-ink-secondary">闲置时释放</span>
        <div role="group" aria-label="闲置时释放" className="flex flex-wrap gap-3">
          {LOCAL_ENGINE_IDLE_OPTIONS.map((option) => (
            <Chip
              key={option}
              data-testid={`local-idle-${option}`}
              aria-pressed={idleMinutes === option}
              className={cn(idleMinutes === option && 'bg-selected')}
              disabled={busy}
              onClick={() => {
                setError(undefined)
                saveSemanticRecall({ idleMinutes: option }).catch((caught: unknown) =>
                  setError(messageOf(caught))
                )
              }}
            >
              {option === 0 ? '不释放' : `${option} 分钟`}
            </Chip>
          ))}
        </div>
      </div>

      {error === undefined ? null : (
        <p data-testid="local-model-error" className="text-c1 text-danger">
          {error}
        </p>
      )}
    </div>
  )
}
